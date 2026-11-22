import { queryRead } from "../../config/database";

/**
 * Float reserve forecasting.
 *
 * For each telecom provider we derive an hourly disbursement burn rate from
 * the trailing 7 days of completed withdrawals (a simple moving average over
 * the 168 hourly buckets), then project:
 *   - the reserve required to cover the next 48 hours of payouts
 *   - the hours until the current float balance is depleted
 *
 * The "current balance" is the most recent provider-reported float balance
 * recorded by the hourly float reconciliation worker in
 * `provider_balance_ledger`.
 */

export const FORECAST_LOOKBACK_DAYS = 7;
export const FORECAST_LOOKBACK_HOURS = FORECAST_LOOKBACK_DAYS * 24;
export const FORECAST_HORIZON_HOURS = 48;

/** Hours of runway below which a provider is flagged as `critical`. */
const CRITICAL_RUNWAY_HOURS = 24;

export type FloatRiskLevel = "ok" | "warning" | "critical" | "unknown";

export interface ProviderFloatForecast {
  provider: string;
  currency: string | null;
  currentBalance: number | null;
  balanceCheckedAt: string | null;
  /** Total completed withdrawal volume in the trailing 7 days. */
  trailingWithdrawalVolume: number;
  trailingWithdrawalCount: number;
  /** Moving-average hourly disbursement over the trailing 7 days. */
  hourlyBurnRate: number;
  /** Burn rate projected over the forecast horizon (48h). */
  projectedBurn48h: number;
  /** Extra float needed to cover the horizon (0 when balance suffices). */
  recommendedTopUp: number;
  /** null when balance is unknown or burn rate is zero (no depletion). */
  hoursUntilDepletion: number | null;
  estimatedDepletionAt: string | null;
  riskLevel: FloatRiskLevel;
}

export interface FloatForecast {
  generatedAt: string;
  lookbackHours: number;
  horizonHours: number;
  providers: ProviderFloatForecast[];
  alerts: Array<{
    provider: string;
    severity: "warning" | "critical";
    message: string;
  }>;
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Pure projection step, exported for reuse/testing. */
export function projectProviderFloat(input: {
  provider: string;
  currency: string | null;
  currentBalance: number | null;
  balanceCheckedAt: Date | null;
  trailingVolume: number;
  trailingCount: number;
  now?: Date;
}): ProviderFloatForecast {
  const now = input.now ?? new Date();
  const hourlyBurnRate = input.trailingVolume / FORECAST_LOOKBACK_HOURS;
  const projectedBurn48h = hourlyBurnRate * FORECAST_HORIZON_HOURS;

  let hoursUntilDepletion: number | null = null;
  let estimatedDepletionAt: string | null = null;
  let recommendedTopUp = 0;
  let riskLevel: FloatRiskLevel = "unknown";

  if (input.currentBalance !== null) {
    recommendedTopUp = Math.max(0, projectedBurn48h - input.currentBalance);

    if (hourlyBurnRate > 0) {
      hoursUntilDepletion = Math.max(0, input.currentBalance / hourlyBurnRate);
      estimatedDepletionAt = new Date(
        now.getTime() + hoursUntilDepletion * 3_600_000,
      ).toISOString();

      if (hoursUntilDepletion < CRITICAL_RUNWAY_HOURS) riskLevel = "critical";
      else if (hoursUntilDepletion < FORECAST_HORIZON_HOURS) riskLevel = "warning";
      else riskLevel = "ok";
    } else {
      riskLevel = "ok";
    }
  }

  return {
    provider: input.provider,
    currency: input.currency,
    currentBalance:
      input.currentBalance === null ? null : round(input.currentBalance),
    balanceCheckedAt: input.balanceCheckedAt?.toISOString() ?? null,
    trailingWithdrawalVolume: round(input.trailingVolume),
    trailingWithdrawalCount: input.trailingCount,
    hourlyBurnRate: round(hourlyBurnRate),
    projectedBurn48h: round(projectedBurn48h),
    recommendedTopUp: round(recommendedTopUp),
    hoursUntilDepletion:
      hoursUntilDepletion === null ? null : round(hoursUntilDepletion, 1),
    estimatedDepletionAt,
    riskLevel,
  };
}

export async function getFloatForecast(
  now: Date = new Date(),
): Promise<FloatForecast> {
  const [burnResult, balanceResult] = await Promise.all([
    queryRead<{ provider: string; volume: string; count: string }>(
      `SELECT provider,
              COALESCE(SUM(amount), 0) AS volume,
              COUNT(*) AS count
         FROM transactions
        WHERE type = 'withdraw'
          AND status = 'completed'
          AND created_at >= $1::timestamptz - make_interval(hours => $2)
          AND created_at <= $1::timestamptz
        GROUP BY provider`,
      [now.toISOString(), FORECAST_LOOKBACK_HOURS],
    ),
    queryRead<{
      provider: string;
      provider_balance: string;
      currency: string;
      checked_at: Date;
    }>(
      `SELECT DISTINCT ON (provider)
              provider, provider_balance, currency, checked_at
         FROM provider_balance_ledger
        ORDER BY provider, checked_at DESC`,
    ),
  ]);

  const burnByProvider = new Map(
    burnResult.rows.map((row) => [
      row.provider.toLowerCase(),
      { volume: Number(row.volume), count: Number(row.count) },
    ]),
  );
  const balanceByProvider = new Map(
    balanceResult.rows.map((row) => [row.provider.toLowerCase(), row]),
  );

  const providerNames = new Set([
    ...burnByProvider.keys(),
    ...balanceByProvider.keys(),
  ]);

  const providers = [...providerNames].sort().map((provider) => {
    const burn = burnByProvider.get(provider);
    const balance = balanceByProvider.get(provider);
    return projectProviderFloat({
      provider,
      currency: balance?.currency ?? null,
      currentBalance: balance ? Number(balance.provider_balance) : null,
      balanceCheckedAt: balance?.checked_at ?? null,
      trailingVolume: burn?.volume ?? 0,
      trailingCount: burn?.count ?? 0,
      now,
    });
  });

  const alerts = providers
    .filter((p) => p.riskLevel === "warning" || p.riskLevel === "critical")
    .map((p) => ({
      provider: p.provider,
      severity: p.riskLevel as "warning" | "critical",
      message: `${p.provider} float projected to deplete in ${p.hoursUntilDepletion}h (balance ${p.currentBalance} ${p.currency ?? ""}, burn ${p.hourlyBurnRate}/h); recommended top-up ${p.recommendedTopUp}`,
    }));

  return {
    generatedAt: now.toISOString(),
    lookbackHours: FORECAST_LOOKBACK_HOURS,
    horizonHours: FORECAST_HORIZON_HOURS,
    providers,
    alerts,
  };
}
