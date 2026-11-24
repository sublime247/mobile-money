import * as Sentry from "@sentry/node";
import { Request, Response, NextFunction } from "express";

/**
 * PII Scrubbing logic
 * Filters out sensitive fields from the data object before it's sent to Sentry.
 */
const scrubSensitiveData = (data: any): any => {
  if (!data || typeof data !== "object") return data;

  if (Array.isArray(data)) {
    return data.map((item) => scrubSensitiveData(item));
  }

  const sensitiveKeys = [
    "password",
    "secret",
    "token",
    "apiKey",
    "phoneNumber",
    "email",
    "stellarSeed",
    "mnemonic",
    "authorization",
    "x-api-key",
  ];

  const scrubbed: Record<string, any> = { ...data };

  for (const key of Object.keys(scrubbed)) {
    const isSensitive = sensitiveKeys.some((sk) =>
      key.toLowerCase().includes(sk.toLowerCase()),
    );

    if (isSensitive) {
      scrubbed[key] = "[REDACTED]";
    } else if (typeof scrubbed[key] === "object") {
      scrubbed[key] = scrubSensitiveData(scrubbed[key]);
    }
  }

  return scrubbed;
};

/**
 * Middleware to enrich Sentry reports with custom breadcrumbs
 */
export const sentryBreadcrumbMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const scope = Sentry.getCurrentScope();

  scope.setContext("request_info", {
    method: req.method,
    url: req.url,
    params: scrubSensitiveData(req.params),
    query: scrubSensitiveData(req.query),
  });

  Sentry.addBreadcrumb({
    category: "auth",
    message: `Authenticated request to ${req.path}`,
    level: "info",
    data: {
      userId: (req as any).user?.id || "anonymous",
    },
  });

  next();
};

/**
 * Request headers that must never reach Sentry, matched case-insensitively.
 * Authorization and Cookie can carry bearer tokens / session secrets, so
 * they are redacted outright rather than passed through the generic
 * scrubSensitiveData key-matching above.
 */
const SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
];

const scrubHeaders = (
  headers: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!headers) return headers;

  const scrubbed: Record<string, unknown> = { ...headers };
  for (const key of Object.keys(scrubbed)) {
    if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
      scrubbed[key] = "[REDACTED]";
    }
  }
  return scrubbed;
};

/**
 * Global Sentry configuration with PII scrubbing in beforeSend.
 * Scrubs the request body (via scrubSensitiveData) and sensitive request
 * headers (Authorization, Cookie, Set-Cookie, X-Api-Key) before any event
 * is transmitted.
 */
export const initSentry = (dsn: string, release?: string) => {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    release: release || process.env.SENTRY_RELEASE,
    beforeSend(event) {
      if (event.request?.data) {
        event.request.data = scrubSensitiveData(event.request.data);
      }
      if (event.request?.headers) {
        event.request.headers = scrubHeaders(
          event.request.headers as Record<string, unknown>,
        ) as typeof event.request.headers;
      }
      return event;
    },
    tracesSampleRate: 1.0,
  });

  registerProcessErrorCapture();
};

/**
 * Captures process-level failures that never reach Express's error
 * middleware: unhandled promise rejections and uncaught exceptions.
 * Safe to call multiple times; listeners are only attached once.
 */
let processHandlersRegistered = false;
export const registerProcessErrorCapture = () => {
  if (processHandlersRegistered) return;
  processHandlersRegistered = true;

  process.on("unhandledRejection", (reason) => {
    Sentry.captureException(
      reason instanceof Error ? reason : new Error(String(reason)),
      { tags: { source: "unhandledRejection" } },
    );
  });

  process.on("uncaughtException", (error) => {
    Sentry.captureException(error, {
      tags: { source: "uncaughtException" },
    });
  });
};
