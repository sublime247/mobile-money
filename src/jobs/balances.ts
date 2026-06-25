import logger from "../utils/logger";
import { AirtelService } from "../services/mobilemoney/providers/airtel";
import { MTNProvider } from "../services/mobilemoney/providers/mtn";

type ProviderName = "mtn" | "airtel";

interface ProviderBalance {
  provider: ProviderName;
  availableBalance: number;
  currency: string;
  threshold: number;
}

interface ProviderBalanceApiResult {
  success: boolean;
  data?: {
    availableBalance: number;
    currency: string;
  };
  error?: unknown;
}

interface AlertPayload {
  alertType: "provider_balance_low";
  severity: "warning";
  generatedAt: string;
  providers: ProviderBalance[];
}

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
    process.env.EMAIL_ALERT_WEBHOOK_URL,
  ].filter((value): value is string => Boolean(value && value.trim()));

  return [...new Set(values)];
}

async function postAlert(url: string, payload: AlertPayload): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook responded with HTTP ${response.status}`);
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function fetchProviderBalance(
  provider: ProviderName,
  threshold: number,
  fetchBalance: () => Promise<ProviderBalanceApiResult>,
): Promise<ProviderBalance | null> {
  const result = await fetchBalance();

  if (!result.success || !result.data) {
    logger.error(
      `[balances] Failed to fetch ${provider.toUpperCase()} balance: ${toErrorMessage(result.error)}`,
    );
    return null;
  }

  return {
    provider,
    availableBalance: result.data.availableBalance,
    currency: result.data.currency,
    threshold,
  };
}

export async function runProviderBalanceAlertJob(): Promise<void> {
  const defaultThreshold = parseThreshold(
    process.env.PROVIDER_MIN_BALANCE_THRESHOLD,
    1000,
  );

  const mtnThreshold = parseThreshold(
    process.env.MTN_MIN_BALANCE_THRESHOLD,
    defaultThreshold,
  );
  const airtelThreshold = parseThreshold(
    process.env.AIRTEL_MIN_BALANCE_THRESHOLD,
    defaultThreshold,
  );

  const mtnProvider = new MTNProvider();
  const airtelProvider = new AirtelService();

  const [mtnBalance, airtelBalance] = await Promise.all([
    fetchProviderBalance("mtn", mtnThreshold, () =>
      mtnProvider.getOperationalBalance(),
    ),
    fetchProviderBalance("airtel", airtelThreshold, () =>
      airtelProvider.getOperationalBalance(),
    ),
  ]);

  const available = [mtnBalance, airtelBalance].filter(
    (balance): balance is ProviderBalance => balance !== null,
  );

  if (available.length === 0) {
    console.warn("[balances] No provider balances were available");
    return;
  }

  const lowBalances = available.filter(
    (balance) => balance.availableBalance < balance.threshold,
  );

  if (lowBalances.length === 0) {
    console.log("[balances] All provider balances are above thresholds");
    return;
  }

  const webhookUrls = resolveAlertWebhookUrls();

  if (webhookUrls.length === 0) {
    console.warn(
      "[balances] Low provider balances detected but no alert webhook URL is configured",
    );
    return;
  }

  const payload: AlertPayload = {
    alertType: "provider_balance_low",
    severity: "warning",
    generatedAt: new Date().toISOString(),
    providers: lowBalances,
  };

  for (const webhookUrl of webhookUrls) {
    try {
      await postAlert(webhookUrl, payload);
    } catch (error) {
      logger.error(
        `[balances] Failed to send balance alert to ${webhookUrl}: ${toErrorMessage(error)}`,
      );
    }
  }

  console.warn(
    `[balances] Alerted treasury for ${lowBalances.length} low balance provider(s)`,
  );
}
