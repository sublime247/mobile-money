import axios from "axios";
import logger from "../utils/logger";

export type AlertSeverity = "warning" | "error" | "critical";

export interface AlertContext {
  transactionId?: string;
  provider: string;
  error: string;
  timestamp?: string;
  severity?: AlertSeverity;
  /** Extra key/value pairs rendered as additional fields in the alert message. */
  meta?: Record<string, string | number>;
}

export interface AlertDispatchResult {
  slack: "sent" | "skipped_no_url" | "skipped_rate_limited" | "failed";
  discord: "sent" | "skipped_no_url" | "skipped_rate_limited" | "failed";
}

const SEVERITY_COLOR: Record<AlertSeverity, number> = {
  warning: 0xf2c744, // yellow
  error: 0xe8590c, // orange
  critical: 0xe03131, // red
};

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  warning: "⚠️",
  error: "🔴",
  critical: "🚨",
};

/**
 * Rate limits alert dispatch per provider so a sustained outage produces a
 * handful of notifications, not one per failed request. Rate limiting is
 * global to the alert (not per-severity), keyed by provider, so a critical
 * alert during an active cooldown is still suppressed - the cooldown itself
 * is short enough (default 5 minutes) that this doesn't meaningfully delay
 * awareness of an escalating incident.
 */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const lastSentAt = new Map<string, number>();

function isRateLimited(provider: string, cooldownMs: number): boolean {
  const last = lastSentAt.get(provider);
  if (last === undefined) return false;
  return Date.now() - last < cooldownMs;
}

function markSent(provider: string): void {
  lastSentAt.set(provider, Date.now());
}

/** Test-only: clears the in-memory rate-limit state between test cases. */
export function resetAlertRateLimits(): void {
  lastSentAt.clear();
}

function buildSlackPayload(context: AlertContext) {
  const severity = context.severity ?? "error";
  const timestamp = context.timestamp ?? new Date().toISOString();
  const fields = [
    { type: "mrkdwn", text: `*Provider:*\n${context.provider}` },
    { type: "mrkdwn", text: `*Error:*\n${context.error}` },
    { type: "mrkdwn", text: `*Timestamp:*\n${timestamp}` },
  ];
  if (context.transactionId) {
    fields.push({ type: "mrkdwn", text: `*Transaction ID:*\n${context.transactionId}` });
  }
  for (const [key, value] of Object.entries(context.meta ?? {})) {
    fields.push({ type: "mrkdwn", text: `*${key}:*\n${value}` });
  }

  return {
    text: `${SEVERITY_EMOJI[severity]} Payment provider alert: ${context.provider}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${SEVERITY_EMOJI[severity]} Payment provider alert`,
        },
      },
      { type: "section", fields },
    ],
  };
}

function buildDiscordPayload(context: AlertContext) {
  const severity = context.severity ?? "error";
  const timestamp = context.timestamp ?? new Date().toISOString();
  const fields = [
    { name: "Provider", value: context.provider, inline: true },
    { name: "Error", value: context.error, inline: true },
    { name: "Timestamp", value: timestamp, inline: false },
  ];
  if (context.transactionId) {
    fields.push({ name: "Transaction ID", value: context.transactionId, inline: true });
  }
  for (const [key, value] of Object.entries(context.meta ?? {})) {
    fields.push({ name: key, value: String(value), inline: true });
  }

  return {
    embeds: [
      {
        title: `${SEVERITY_EMOJI[severity]} Payment provider alert: ${context.provider}`,
        color: SEVERITY_COLOR[severity],
        fields,
        timestamp,
      },
    ],
  };
}

async function postWebhook(
  url: string,
  payload: unknown,
  channel: "slack" | "discord",
): Promise<"sent" | "failed"> {
  try {
    await axios.post(url, payload, { timeout: 5000 });
    return "sent";
  } catch (err) {
    logger.error(
      { channel, error: err instanceof Error ? err.message : String(err) },
      "Failed to deliver alert webhook",
    );
    return "failed";
  }
}

/**
 * Sends a formatted alert to whichever of Slack / Discord have a configured
 * webhook URL (SLACK_ALERT_WEBHOOK_URL / DISCORD_ALERT_WEBHOOK_URL). Missing
 * configuration for a channel is not an error - it's simply skipped, so a
 * deployment only using one of the two isn't forced to configure both.
 *
 * Rate-limited per provider (default: one alert per 5 minutes) to avoid an
 * alert storm during a sustained outage; pass `cooldownMs` to override.
 *
 * @example
 * await sendAlert({
 *   provider: "airtel",
 *   error: "Circuit breaker OPEN: error rate exceeded 50% threshold",
 *   severity: "critical",
 *   transactionId: tx.id,
 * });
 */
export async function sendAlert(
  context: AlertContext,
  options?: { cooldownMs?: number },
): Promise<AlertDispatchResult> {
  const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const rateLimited = isRateLimited(context.provider, cooldownMs);

  const slackUrl = process.env.SLACK_ALERT_WEBHOOK_URL;
  const discordUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;

  const result: AlertDispatchResult = {
    slack: !slackUrl ? "skipped_no_url" : rateLimited ? "skipped_rate_limited" : "failed",
    discord: !discordUrl ? "skipped_no_url" : rateLimited ? "skipped_rate_limited" : "failed",
  };

  if (rateLimited) {
    logger.debug(
      { provider: context.provider },
      "Alert suppressed: provider is within its alert cooldown window",
    );
    return result;
  }

  const dispatches: Promise<void>[] = [];
  if (slackUrl) {
    dispatches.push(
      postWebhook(slackUrl, buildSlackPayload(context), "slack").then((status) => {
        result.slack = status;
      }),
    );
  }
  if (discordUrl) {
    dispatches.push(
      postWebhook(discordUrl, buildDiscordPayload(context), "discord").then((status) => {
        result.discord = status;
      }),
    );
  }

  if (dispatches.length === 0) {
    logger.warn(
      "sendAlert called but neither SLACK_ALERT_WEBHOOK_URL nor DISCORD_ALERT_WEBHOOK_URL is configured",
    );
    return result;
  }

  await Promise.all(dispatches);
  markSent(context.provider);
  return result;
}

/**
 * Convenience wrapper for a low-balance condition, kept separate from
 * `sendAlert` so a future balance-monitoring job can call it directly with
 * just the numbers it has on hand, without constructing an AlertContext by
 * hand each time.
 */
export async function sendLowBalanceAlert(params: {
  provider: string;
  currentBalance: number;
  threshold: number;
  currency: string;
}): Promise<AlertDispatchResult> {
  const shortfallPct = Math.round(
    ((params.threshold - params.currentBalance) / params.threshold) * 100,
  );
  return sendAlert({
    provider: params.provider,
    error: `Balance below threshold: ${params.currentBalance} ${params.currency} (threshold: ${params.threshold} ${params.currency}, ${shortfallPct}% short)`,
    severity: shortfallPct >= 50 ? "critical" : shortfallPct >= 25 ? "error" : "warning",
    meta: {
      currentBalance: params.currentBalance,
      threshold: params.threshold,
      currency: params.currency,
    },
  });
}

/** The Redis threshold already limits this alert to once per failure streak. */
export async function sendProviderAuthFailureAlert(
  provider: string,
  count: number,
  status: number,
): Promise<void> {
  const url = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) {
    logger.warn("Slack alert webhook is not configured", { provider });
    return;
  }

  await postWebhook(url, buildSlackPayload({
    provider,
    error: `${count} consecutive provider authentication failures`,
    severity: "critical",
    meta: { "HTTP status": status },
  }), "slack");
}

export interface WebhookBacklog {
  depth: number;
  oldestAgeSeconds?: number;
}

export function webhookBacklogAction(
  { depth, oldestAgeSeconds = 0 }: WebhookBacklog,
  incidentActive: boolean,
): "trigger" | "resolve" | undefined {
  if (depth > 500 || oldestAgeSeconds > 900) {
    return incidentActive ? undefined : "trigger";
  }
  if (incidentActive && depth < 100) return "resolve";
  return undefined;
}

export async function dispatchWebhookBacklogAlert(
  routingKey: string,
  dedupKey: string,
  action: "trigger" | "resolve",
  backlog: WebhookBacklog,
): Promise<void> {
  await axios.post(
    "https://events.pagerduty.com/v2/enqueue",
    {
      routing_key: routingKey,
      event_action: action,
      dedup_key: dedupKey,
      ...(action === "trigger" && {
        payload: {
          summary: "Merchant webhook delivery retry backlog exceeds threshold",
          source: "mobile-money-api",
          severity: "critical",
          custom_details: backlog,
        },
      }),
    },
    { timeout: 5000, maxRedirects: 0 },
  );
}
