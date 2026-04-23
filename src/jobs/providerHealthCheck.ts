import { checkMobileMoneyHealth } from "../services/mobilemoney/providers/healthCheck";

interface ProviderHealthAlert {
  alertType: "provider_health_status";
  severity: "critical" | "warning";
  generatedAt: string;
  downProviders: string[];
  allProviders: Record<string, { status: string; responseTime: number | null }>;
}

function resolveHealthAlertWebhookUrls(): string[] {
  const values = [
    process.env.PROVIDER_HEALTH_WEBHOOK_URL,
    process.env.SLACK_ALERTS_WEBHOOK_URL,
    process.env.PAGERDUTY_WEBHOOK_URL,
  ].filter((value): value is string => Boolean(value && value.trim()));

  return [...new Set(values)];
}

async function postHealthAlert(url: string, payload: ProviderHealthAlert): Promise<void> {
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

export async function runProviderHealthCheckJob(): Promise<void> {
  console.log("[provider-health] Starting provider health check");

  try {
    const healthResult = await checkMobileMoneyHealth();

    const downProviders: string[] = [];
    const allProviders: Record<string, { status: string; responseTime: number | null }> = {};

    for (const [providerName, health] of Object.entries(healthResult.providers)) {
      allProviders[providerName] = {
        status: health.status,
        responseTime: health.responseTime,
      };

      if (health.status === "down") {
        downProviders.push(providerName);
      }
    }

    console.log(`[provider-health] Health check completed - ${downProviders.length} provider(s) down`);

    if (downProviders.length === 0) {
      console.log("[provider-health] All providers are operational");
      return;
    }

    const webhookUrls = resolveHealthAlertWebhookUrls();

    if (webhookUrls.length === 0) {
      console.warn(
        "[provider-health] Provider outage detected but no alert webhook URL is configured",
      );
      return;
    }

    const severity = downProviders.length >= 2 ? "critical" : "warning";

    const payload: ProviderHealthAlert = {
      alertType: "provider_health_status",
      severity,
      generatedAt: new Date().toISOString(),
      downProviders,
      allProviders,
    };

    for (const webhookUrl of webhookUrls) {
      try {
        await postHealthAlert(webhookUrl, payload);
        console.log(`[provider-health] Alert sent to ${webhookUrl}`);
      } catch (error) {
        console.error(
          `[provider-health] Failed to send alert to ${webhookUrl}: ${toErrorMessage(error)}`,
        );
      }
    }

    console.warn(
      `[provider-health] Alerted for ${downProviders.length} down provider(s): ${downProviders.join(", ")}`,
    );
  } catch (error) {
    console.error(`[provider-health] Job failed: ${toErrorMessage(error)}`);
    throw error;
  }
}
