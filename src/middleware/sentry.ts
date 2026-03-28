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
 * Global Sentry configuration with PII scrubbing in beforeSend
 */
export const initSentry = (dsn: string) => {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    beforeSend(event) {
      if (event.request?.data) {
        event.request.data = scrubSensitiveData(event.request.data);
      }
      return event;
    },
    tracesSampleRate: 1.0,
  });
};