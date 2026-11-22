import logger from "../utils/logger";
import { pool } from "../config/database";
import { LedgerService } from "../services/ledgerService";
import { MTNProvider } from "../services/mobilemoney/providers/mtn";
import { AirtelService } from "../services/mobilemoney/providers/airtel";

/**
 * Hourly provider float balance reconciliation (#2372).
 *
 * Polls each active provider's reported float balance and compares it
 * against the "Mobile Money Float" ledger account (account code "1100" —
 * see `ledgerService.ts`), which today tracks the combined float across
 * every provider rather than one account per provider. Every check is
 * recorded in `provider_balance_ledger` (see migrations/20261026_*) for
 * audit, and a discrepancy beyond tolerance fires an alert.
 *
 * Only providers with a reliable, typed `getOperationalBalance()` are
 * polled here (MTN, Airtel — the same two `src/jobs/balances.ts` already
 * trusts for low-balance alerting). Orange and Wave currently either lack
 * this method (`orange.ts`, `waveSenegal.ts`) or return an untyped `unknown`
 * payload (country variants like `orangeGuinea.ts`), so wiring them in here
 * would mean guessing at the response shape rather than reconciling a real
 * number — add them once their balance integration is typed and tested.
 */

const FLOAT_ACCOUNT_CODE = "1100";
const DEFAULT_TOLERANCE_USD = 50.0;

function resolveAlertWebhookUrls(): string[] {
  const values = [
    process.env.BALANCE_ALERT_WEBHOOK_URL,
    process.env.TREASURY_ALERT_WEBHOOK_URL,
    process.env.SLACK_ALERTS_WEBHOOK_URL,
  ].filter((value): value is string => Boolean(value && value.trim()));

  return [...new Set(values)];
}

async function postDiscrepancyAlert(
  url: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook responded with HTTP ${response.status}`);
  }
}

export interface ProviderBalanceSnapshot {
  provider: string;
  availableBalance: number;
  currency: string;
}

async function fetchProviderBalances(): Promise<ProviderBalanceSnapshot[]> {
  const mtnProvider = new MTNProvider();
  const airtelProvider = new AirtelService();

  const results = await Promise.all([
    mtnProvider.getOperationalBalance().then(
      (result) =>
        result.success && result.data
          ? {
              provider: "mtn",
              availableBalance: result.data.availableBalance,
              currency: result.data.currency,
            }
          : null,
      (error) => {
        logger.error("[float-reconciliation] Failed to fetch MTN balance:", error);
        return null;
      },
    ),
    airtelProvider.getOperationalBalance().then(
      (result: any) =>
        result?.success && result?.data
          ? {
              provider: "airtel",
              availableBalance: Number(
                result.data.availableBalance ?? result.data.balance ?? NaN,
              ),
              currency: result.data.currency ?? "XAF",
            }
          : null,
      (error: unknown) => {
        logger.error(
          "[float-reconciliation] Failed to fetch Airtel balance:",
          error,
        );
        return null;
      },
    ),
  ]);

  return results.filter(
    (balance): balance is ProviderBalanceSnapshot =>
      balance !== null && Number.isFinite(balance.availableBalance),
  );
}

function parseTolerance(): number {
  const raw = process.env.FLOAT_RECONCILIATION_TOLERANCE_USD;
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TOLERANCE_USD;
}

async function recordReconciliation(
  snapshot: ProviderBalanceSnapshot,
  ledgerBalance: number,
  discrepancy: number,
  alerted: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO provider_balance_ledger
       (provider, provider_balance, ledger_balance, discrepancy, currency, alerted)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      snapshot.provider,
      snapshot.availableBalance,
      ledgerBalance,
      discrepancy,
      snapshot.currency,
      alerted,
    ],
  );
}

/**
 * Runs one reconciliation pass: fetch every integrated provider's float
 * balance, compare the combined total against the ledger's float account,
 * persist an audit row per provider, and alert if the combined discrepancy
 * exceeds tolerance.
 */
export async function runFloatReconciliationJob(
  ledgerService: LedgerService = new LedgerService(),
): Promise<void> {
  const balances = await fetchProviderBalances();

  if (balances.length === 0) {
    logger.warn("[float-reconciliation] No provider balances were available");
    return;
  }

  const ledgerBalance = await ledgerService.getAccountBalance(
    FLOAT_ACCOUNT_CODE,
  );

  const combinedProviderBalance = balances.reduce(
    (sum, balance) => sum + balance.availableBalance,
    0,
  );
  const discrepancy = combinedProviderBalance - ledgerBalance;
  const tolerance = parseTolerance();
  const alerted = Math.abs(discrepancy) > tolerance;

  for (const balance of balances) {
    try {
      await recordReconciliation(balance, ledgerBalance, discrepancy, alerted);
    } catch (error) {
      logger.error(
        `[float-reconciliation] Failed to record reconciliation for ${balance.provider}:`,
        error,
      );
    }
  }

  if (alerted) {
    logger.error(
      `[float-reconciliation] Discrepancy ${discrepancy.toFixed(2)} exceeds tolerance ${tolerance.toFixed(2)} (provider ${combinedProviderBalance.toFixed(2)} vs ledger ${ledgerBalance.toFixed(2)})`,
    );

    const webhookUrls = resolveAlertWebhookUrls();
    if (webhookUrls.length === 0) {
      logger.warn(
        "[float-reconciliation] Discrepancy detected but no alert webhook URL is configured",
      );
    } else {
      const payload = {
        alertType: "provider_float_discrepancy",
        severity: "warning",
        generatedAt: new Date().toISOString(),
        combinedProviderBalance,
        ledgerBalance,
        discrepancy,
        tolerance,
        providers: balances,
      };

      for (const webhookUrl of webhookUrls) {
        try {
          await postDiscrepancyAlert(webhookUrl, payload);
        } catch (error) {
          logger.error(
            `[float-reconciliation] Failed to send discrepancy alert to ${webhookUrl}:`,
            error,
          );
        }
      }
    }
  } else {
    console.log(
      `[float-reconciliation] Balances reconciled within tolerance (diff ${discrepancy.toFixed(2)})`,
    );
  }
}
