import { NextFunction, Request, RequestHandler, Response } from "express";
import {
  buildSessionAnomalyAuditEvent,
  getCurrentRequestIp,
  logSessionAnomaly,
  normalizeIpAddress,
  sessionAnomalyLogger,
} from "./logger";

export {
  buildSessionAnomalyAuditEvent,
  getCurrentRequestIp,
  logSessionAnomaly,
  normalizeIpAddress,
  sessionAnomalyLogger,
};

interface SlackAlertConfig {
  webhookUrl: string;
  appName: string;
  environment: string;
  windowMs: number;
  maxPerWindow: number;
  maxStackChars: number;
  maxMessageChars: number;
  enabled: boolean;
  allowInTest: boolean;
}

interface SlackAlertDependencies {
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "warn" | "error">;
  now?: () => Date;
}

interface CriticalErrorDetails {
  statusCode: number;
  method: string;
  path: string;
  requestId?: string;
  userAgent?: string;
  host?: string;
  responseTimeMs?: number;
  timestamp: string;
  error?: Error;
}

interface SlackAlertSample {
  statusCode: number;
  method: string;
  path: string;
  message?: string;
}

interface RateLimitDecision {
  allowAlert: boolean;
  sendSummary: boolean;
  summaryCount: number;
  summarySample: SlackAlertSample | null;
}

interface SlackPayload {
  text: string;
  blocks?: Array<Record<string, unknown>>;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 5;
const DEFAULT_MAX_STACK_CHARS = 2_400;
const DEFAULT_MAX_MESSAGE_CHARS = 600;

const alertState: {
  windowStartMs: number;
  sentInWindow: number;
  suppressedInWindow: number;
  lastSuppressedSample: SlackAlertSample | null;
} = {
  windowStartMs: 0,
  sentInWindow: 0,
  suppressedInWindow: 0,
  lastSuppressedSample: null,
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function getSlackAlertConfig(
  overrides: Partial<SlackAlertConfig> = {},
): SlackAlertConfig {
  const appName =
    overrides.appName ??
    process.env.SLACK_ALERTS_APP_NAME ??
    process.env.APP_NAME ??
    "mobile-money-api";

  const environment =
    overrides.environment ?? process.env.NODE_ENV ?? "development";

  const windowMs =
    overrides.windowMs ??
    parsePositiveInt(process.env.SLACK_ALERTS_WINDOW_MS, DEFAULT_WINDOW_MS);

  const maxPerWindow =
    overrides.maxPerWindow ??
    parsePositiveInt(
      process.env.SLACK_ALERTS_MAX_PER_WINDOW,
      DEFAULT_MAX_PER_WINDOW,
    );

  const maxStackChars =
    overrides.maxStackChars ??
    parsePositiveInt(
      process.env.SLACK_ALERTS_MAX_STACK_CHARS,
      DEFAULT_MAX_STACK_CHARS,
    );

  const maxMessageChars =
    overrides.maxMessageChars ??
    parsePositiveInt(
      process.env.SLACK_ALERTS_MAX_MESSAGE_CHARS,
      DEFAULT_MAX_MESSAGE_CHARS,
    );

  const enabled =
    overrides.enabled ?? process.env.SLACK_ALERTS_ENABLED !== "false";
  const allowInTest =
    overrides.allowInTest ?? process.env.SLACK_ALERTS_ALLOW_IN_TEST === "true";

  return {
    webhookUrl:
      overrides.webhookUrl ?? process.env.SLACK_ALERTS_WEBHOOK_URL ?? "",
    appName,
    environment,
    windowMs,
    maxPerWindow,
    maxStackChars,
    maxMessageChars,
    enabled,
    allowInTest,
  };
}

function loggedPath(req: Request): string {
  const raw = req.originalUrl ?? req.url ?? "/";
  const q = raw.indexOf("?");
  return (q >= 0 ? raw.slice(0, q) : raw) || "/";
}

function getRequestId(req: Request): string | undefined {
  const request = req as Request & { id?: string };
  if (request.id) return request.id;
  const header = req.headers["x-request-id"];
  return Array.isArray(header) ? header[0] : header;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 14))}...truncated`;
}

function formatStack(error: Error | undefined, maxChars: number): string | null {
  if (!error?.stack) return null;
  return truncate(error.stack, maxChars);
}

function buildAlertPayload(
  details: CriticalErrorDetails,
  config: SlackAlertConfig,
): SlackPayload {
  const summary = `${details.statusCode} ${details.method} ${details.path}`;
  const fields = [
    `*Status*: ${details.statusCode}`,
    `*Method*: ${details.method}`,
    `*Path*: ${details.path}`,
    `*Request ID*: ${details.requestId ?? "n/a"}`,
    `*Environment*: ${config.environment}`,
    `*Time*: ${details.timestamp}`,
  ];

  if (details.responseTimeMs !== undefined) {
    fields.push(`*Response Time*: ${details.responseTimeMs}ms`);
  }

  if (details.host) {
    fields.push(`*Host*: ${details.host}`);
  }

  if (details.userAgent) {
    fields.push(
      `*User-Agent*: ${truncate(
        details.userAgent,
        Math.min(160, config.maxMessageChars),
      )}`,
    );
  }

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${config.appName} critical error`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${summary}*`,
      },
    },
    {
      type: "section",
      fields: fields.slice(0, 10).map((text) => ({
        type: "mrkdwn",
        text,
      })),
    },
  ];

  const errorMessage = details.error?.message;
  if (errorMessage) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Error Message*\n${truncate(errorMessage, config.maxMessageChars)}`,
      },
    });
  }

  const stack = formatStack(details.error, config.maxStackChars);
  if (stack) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Stack Trace*\n\`\`\`${stack}\`\`\``,
      },
    });
  }

  return {
    text: `${config.appName} critical error: ${summary}`,
    blocks,
  };
}

function buildSummaryPayload(
  summaryCount: number,
  config: SlackAlertConfig,
  sample: SlackAlertSample | null,
): SlackPayload {
  const windowSeconds = Math.round(config.windowMs / 1000);
  const headline = "High error volume detected";
  const summaryText = `Suppressed ${summaryCount} additional 5xx responses in the last ${windowSeconds}s to reduce noise.`;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: headline,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: summaryText,
      },
    },
    {
      type: "section",
      fields: [
        `*Environment*: ${config.environment}`,
        `*App*: ${config.appName}`,
      ].map((text) => ({
        type: "mrkdwn",
        text,
      })),
    },
  ];

  if (sample) {
    const sampleText = `Latest suppressed example: ${sample.statusCode} ${sample.method} ${sample.path}${sample.message ? ` - ${sample.message}` : ""}`;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(sampleText, config.maxMessageChars),
      },
    });
  }

  return {
    text: `${headline}: ${summaryText}`,
    blocks,
  };
}

function getRateLimitDecision(
  nowMs: number,
  config: SlackAlertConfig,
  sample: SlackAlertSample,
): RateLimitDecision {
  if (alertState.windowStartMs === 0) {
    alertState.windowStartMs = nowMs;
  }

  let sendSummary = false;
  let summaryCount = 0;
  let summarySample: SlackAlertSample | null = null;

  if (nowMs - alertState.windowStartMs >= config.windowMs) {
    summaryCount = alertState.suppressedInWindow;
    summarySample = alertState.lastSuppressedSample;
    alertState.windowStartMs = nowMs;
    alertState.sentInWindow = 0;
    alertState.suppressedInWindow = 0;
    alertState.lastSuppressedSample = null;

    if (summaryCount > 0) {
      sendSummary = true;
      alertState.sentInWindow = 1;
    }
  }

  if (alertState.sentInWindow < config.maxPerWindow) {
    alertState.sentInWindow += 1;
    return { allowAlert: true, sendSummary, summaryCount, summarySample };
  }

  alertState.suppressedInWindow += 1;
  alertState.lastSuppressedSample = sample;
  return { allowAlert: false, sendSummary, summaryCount, summarySample };
}

async function postToSlack(
  payload: SlackPayload,
  config: SlackAlertConfig,
  deps: SlackAlertDependencies,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const logger = deps.logger ?? console;

  try {
    const response = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.warn(
        `[slack-alerts] webhook responded with HTTP ${response.status}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[slack-alerts] failed to send alert: ${message}`);
  }
}

async function notifySlackAlert(
  details: CriticalErrorDetails,
  overrides: Partial<SlackAlertConfig> = {},
  deps: SlackAlertDependencies = {},
): Promise<void> {
  const config = getSlackAlertConfig(overrides);

  if (!config.enabled) return;
  if (!config.webhookUrl) return;
  if (config.environment === "test" && !config.allowInTest) return;

  const sample: SlackAlertSample = {
    statusCode: details.statusCode,
    method: details.method,
    path: details.path,
    message: details.error?.message,
  };

  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const decision = getRateLimitDecision(nowMs, config, sample);

  if (decision.sendSummary && decision.summaryCount > 0) {
    await postToSlack(
      buildSummaryPayload(
        decision.summaryCount,
        config,
        decision.summarySample,
      ),
      config,
      deps,
    );
  }

  if (!decision.allowAlert) return;

  await postToSlack(buildAlertPayload(details, config), config, deps);
}

export function criticalErrorNotifier(
  overrides: Partial<SlackAlertConfig> = {},
  deps: SlackAlertDependencies = {},
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();

    res.on("finish", () => {
      if (res.statusCode < 500) return;

      const durationNs = process.hrtime.bigint() - start;
      const responseTimeMs = Math.round(Number(durationNs) / 1e4) / 100;
      const error = (res.locals as Record<string, unknown>)["__criticalError"];

      const details: CriticalErrorDetails = {
        statusCode: res.statusCode,
        method: req.method,
        path: loggedPath(req),
        requestId: getRequestId(req),
        userAgent: Array.isArray(req.headers["user-agent"])
          ? req.headers["user-agent"][0]
          : req.headers["user-agent"],
        host: Array.isArray(req.headers.host)
          ? req.headers.host[0]
          : req.headers.host,
        responseTimeMs,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error : undefined,
      };

      void notifySlackAlert(details, overrides, deps);
    });

    next();
  };
}
