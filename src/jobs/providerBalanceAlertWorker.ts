import logger from "../utils/logger";
import { MTNProvider } from "../services/mobilemoney/providers/mtn";
import { AirtelService } from "../services/mobilemoney/providers/airtel";
import { OrangeGuineaProvider } from "../services/mobilemoney/providers/orangeGuinea";
import { momoProviderFloatBalance } from "../utils/metrics";
import { sendAdminBalanceAlert, type LowBalanceAlert } from "../services/notifications";
import { notifySlackAlert } from "../services/loggers";

export type ProviderName = "mtn" | "airtel" | "orange";

export interface ProviderBalanceInfo {
  provider: ProviderName;
  availableBalance: number;
  currency: string;
  threshold: number;
}

export interface OperationalBalanceResponse {
  success: boolean;
  data?: {
    availableBalance?: number | string;
    balance?: number | string;
    currency?: string;
  };
  error?: unknown;
}

export interface ProviderBalanceCheckOptions {
  providers?: {
    mtn?: { getOperationalBalance: () => Promise<OperationalBalanceResponse> };
    airtel?: { getOperationalBalance: () => Promise<OperationalBalanceResponse> };
    orange?: { getOperationalBalance: () => Promise<OperationalBalanceResponse> };
  };
  thresholds?: Partial<Record<ProviderName, number>>;
  defaultThreshold?: number;
  onAlert?: (lowBalances: ProviderBalanceInfo[]) => Promise<void> | void;
}

export const DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes recurring schedule
export const DEFAULT_MIN_BALANCE_THRESHOLD = 1000;

let workerTimer: NodeJS.Timeout | null = null;

function parseThreshold(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveAlertWebhookUrls(): string[] {
  const values = [
    process.env.BALANCE_ALERT_WEBHOOK_URL,
    process.env.TREASURY_ALERT_WEBHOOK_URL,
    process.env.SLACK_ALERTS_WEBHOOK_URL,
    process.env.DISCORD_ALERTS_WEBHOOK_URL,
    process.env.EMAIL_ALERT_WEBHOOK_URL,
  ].filter((value): value is string => Boolean(value && value.trim()));

  return [...new Set(values)];
}

async function postWebhookAlert(url: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Alert webhook responded with status ${response.status}`);
  }
}

/**
 * Runs a single balance check across partner mobile money providers (MTN, Airtel, Orange),
 * updates Prometheus gauge metrics, and triggers alerts if any balance falls below threshold.
 */
export async function runProviderBalanceAlertCheck(
  options: ProviderBalanceCheckOptions = {},
): Promise<{ checked: ProviderBalanceInfo[]; lowBalances: ProviderBalanceInfo[] }> {
  const defaultThreshold =
    options.defaultThreshold ??
    parseThreshold(process.env.PROVIDER_MIN_BALANCE_THRESHOLD, DEFAULT_MIN_BALANCE_THRESHOLD);

  const mtnThreshold =
    options.thresholds?.mtn ??
    parseThreshold(process.env.MTN_MIN_BALANCE_THRESHOLD, defaultThreshold);

  const airtelThreshold =
    options.thresholds?.airtel ??
    parseThreshold(process.env.AIRTEL_MIN_BALANCE_THRESHOLD, defaultThreshold);

  const orangeThreshold =
    options.thresholds?.orange ??
    parseThreshold(process.env.ORANGE_MIN_BALANCE_THRESHOLD, defaultThreshold);

  const mtn = options.providers?.mtn ?? new MTNProvider();
  const airtel = options.providers?.airtel ?? new AirtelService();
  const orange = options.providers?.orange ?? new OrangeGuineaProvider();

  const [mtnRaw, airtelRaw, orangeRaw] = await Promise.all([
    mtn.getOperationalBalance().catch((err: unknown) => ({ success: false, error: err })),
    airtel.getOperationalBalance().catch((err: unknown) => ({ success: false, error: err })),
    orange.getOperationalBalance().catch((err: unknown) => ({ success: false, error: err })),
  ]);

  const checked: ProviderBalanceInfo[] = [];

  // Helper to normalize and record metrics
  const processResult = (
    provider: ProviderName,
    result: OperationalBalanceResponse,
    threshold: number,
    fallbackCurrency: string,
  ) => {
    if (result && result.success && result.data) {
      const rawBal = result.data.availableBalance ?? result.data.balance ?? 0;
      const numBal = Number(rawBal);
      const balance = Number.isFinite(numBal) ? numBal : 0;
      const currency = String(result.data.currency || fallbackCurrency);

      // Expose to Prometheus metrics endpoint
      try {
        momoProviderFloatBalance.labels(provider, currency).set(balance);
      } catch (err) {
        logger.warn(`[provider-balance-worker] Failed to record gauge for ${provider}:`, err);
      }

      checked.push({
        provider,
        availableBalance: balance,
        currency,
        threshold,
      });
    } else {
      logger.error(
        `[provider-balance-worker] Failed to query ${provider.toUpperCase()} balance:`,
        result?.error,
      );
    }
  };

  processResult("mtn", mtnRaw, mtnThreshold, "UGX");
  processResult("airtel", airtelRaw, airtelThreshold, "NGN");
  processResult("orange", orangeRaw, orangeThreshold, "GNF");

  const lowBalances = checked.filter((item) => item.availableBalance < item.threshold);

  if (lowBalances.length > 0) {
    logger.warn(
      { lowCount: lowBalances.length, providers: lowBalances.map((b) => b.provider) },
      "[provider-balance-worker] Low provider float balance detected!",
    );

    // Custom alert callback if provided (e.g. in tests)
    if (options.onAlert) {
      await options.onAlert(lowBalances);
    } else {
      // 1. Dispatch Email & SMS alerts
      const alerts: LowBalanceAlert[] = lowBalances.map((b) => ({
        provider: b.provider,
        availableBalance: b.availableBalance,
        currency: b.currency,
        threshold: b.threshold,
      }));
      await sendAdminBalanceAlert(alerts).catch((err) => {
        logger.error("[provider-balance-worker] sendAdminBalanceAlert failed:", err);
      });

      // 2. Dispatch Slack alert
      const summary = lowBalances
        .map(
          (b) =>
            `${b.provider.toUpperCase()}: ${b.availableBalance} ${b.currency} (threshold: ${b.threshold})`,
        )
        .join("; ");

      await notifySlackAlert(
        {
          statusCode: 500,
          method: "BALANCE_ALERT",
          path: "/jobs/provider-balance-alert",
          timestamp: new Date().toISOString(),
          error: new Error(`Provider Float Balance Low Alert: ${summary}`),
        },
        {
          appName: "provider-balance-alert-worker",
        },
      ).catch((err) => {
        logger.error("[provider-balance-worker] notifySlackAlert failed:", err);
      });

      // 3. Dispatch to any configured webhooks (Slack/Discord/email webhooks)
      const webhookUrls = resolveAlertWebhookUrls();
      const payload = {
        alertType: "provider_balance_low",
        severity: "warning",
        generatedAt: new Date().toISOString(),
        providers: lowBalances,
      };

      for (const url of webhookUrls) {
        try {
          await postWebhookAlert(url, payload);
        } catch (webhookErr) {
          logger.error(`[provider-balance-worker] Failed sending alert to ${url}:`, webhookErr);
        }
      }
    }
  } else {
    logger.info(
      { checkedCount: checked.length },
      "[provider-balance-worker] All queried provider balances are healthy and above threshold",
    );
  }

  return { checked, lowBalances };
}

/**
 * Starts the recurring balance monitoring worker (15-minute interval by default).
 */
export function startProviderBalanceMonitoringWorker(
  intervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
  options: ProviderBalanceCheckOptions = {},
): void {
  if (workerTimer) {
    return;
  }

  const interval =
    Number.parseInt(process.env.PROVIDER_BALANCE_ALERT_INTERVAL_MS || "", 10) ||
    intervalMs;

  workerTimer = setInterval(() => {
    void runProviderBalanceAlertCheck(options).catch((err) => {
      logger.error("[provider-balance-worker] Scheduled balance check failed:", err);
    });
  }, interval);

  if (workerTimer && typeof workerTimer.unref === "function") {
    workerTimer.unref();
  }

  logger.info(
    `[provider-balance-worker] Balance monitoring worker started with ${interval}ms schedule`,
  );
}

/**
 * Stops the balance monitoring worker.
 */
export function stopProviderBalanceMonitoringWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    logger.info("[provider-balance-worker] Balance monitoring worker stopped");
  }
}
