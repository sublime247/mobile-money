import { pool } from "../config/database";

export type ProviderName = "mtn" | "airtel" | "orange";
export type StatusColor = "green" | "yellow" | "red";

export interface ProviderStatusSummary {
  provider: ProviderName;
  status: StatusColor;
  successRate: number; // 0–1
  totalCalls: number;
  avgDurationMs: number | null;
  lastCalledAt: string | null;
}

export interface ProvidersStatusResult {
  providers: ProviderStatusSummary[];
  generatedAt: string;
}

// Green  : success rate >= 95%
// Yellow : success rate >= 80%
// Red    : success rate <  80%
function toStatusColor(successRate: number): StatusColor {
  if (successRate >= 0.95) return "green";
  if (successRate >= 0.8) return "yellow";
  return "red";
}

export async function getProvidersStatus(): Promise<ProvidersStatusResult> {
  const { rows } = await pool.query<{
    provider: ProviderName;
    total: string;
    successes: string;
    avg_duration_ms: string | null;
    last_called_at: Date | null;
  }>(`
    SELECT
      provider,
      COUNT(*)                          AS total,
      COUNT(*) FILTER (WHERE success)   AS successes,
      AVG(duration_ms)                  AS avg_duration_ms,
      MAX(called_at)                    AS last_called_at
    FROM provider_api_calls
    GROUP BY provider
  `);

  const PROVIDERS: ProviderName[] = ["mtn", "airtel", "orange"];

  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  const providers: ProviderStatusSummary[] = PROVIDERS.map((name) => {
    const row = byProvider.get(name);
    if (!row || Number(row.total) === 0) {
      return {
        provider: name,
        status: "red" as StatusColor,
        successRate: 0,
        totalCalls: 0,
        avgDurationMs: null,
        lastCalledAt: null,
      };
    }

    const total = Number(row.total);
    const successes = Number(row.successes);
    const successRate = successes / total;

    return {
      provider: name,
      status: toStatusColor(successRate),
      successRate: Math.round(successRate * 1000) / 1000,
      totalCalls: total,
      avgDurationMs:
        row.avg_duration_ms != null
          ? Math.round(Number(row.avg_duration_ms))
          : null,
      lastCalledAt: row.last_called_at
        ? row.last_called_at.toISOString()
        : null,
    };
  });

  return { providers, generatedAt: new Date().toISOString() };
}

/**
 * Record a single API call outcome for a provider.
 * Call this from mobile money service wrappers after each provider interaction.
 */
export async function recordProviderApiCall(
  provider: ProviderName,
  success: boolean,
  durationMs?: number,
  errorCode?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO provider_api_calls (provider, success, duration_ms, error_code)
     VALUES ($1, $2, $3, $4)`,
    [provider, success, durationMs ?? null, errorCode ?? null],
  );
}
