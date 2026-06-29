import { Request, Response, NextFunction } from "express";
import { UAParser } from "ua-parser-js";
import logger, { childLogger, requestContext } from "../utils/logger";

/**
 * Request pathname without query string (avoids logging ?api_key=…, ?token=…, etc.).
 */
function loggedPath(req: Request): string {
  const raw = req.originalUrl ?? req.url ?? "/";
  const q = raw.indexOf("?");
  return (q >= 0 ? raw.slice(0, q) : raw) || "/";
}

/**
 * Parsed User-Agent fields extracted for analytics.
 * Raw UA string is retained for debugging but does not identify individuals on its own.
 */
interface ParsedUserAgent {
  raw: string | undefined;
  browser: string | undefined;
  os: string | undefined;
  device: "mobile" | "tablet" | "desktop" | "unknown";
}

/**
 * Parses the User-Agent header into structured browser/device fields.
 * Returns undefined values gracefully when the header is absent.
 */
function parseUserAgent(uaString: string | undefined): ParsedUserAgent {
  if (!uaString) {
    return {
      raw: undefined,
      browser: undefined,
      os: undefined,
      device: "unknown",
    };
  }

  const result = new UAParser(uaString).getResult();

  const device: ParsedUserAgent["device"] =
    result.device.type === "mobile"
      ? "mobile"
      : result.device.type === "tablet"
        ? "tablet"
        : result.browser.name
          ? "desktop"
          : "unknown";

  return {
    raw: uaString,
    browser: result.browser.name,
    os: result.os.name,
    device,
  };
}

/**
 * Logs each completed HTTP request. Uses pathname only (no query string),
 * and does not log headers or body, so API keys, tokens, and secrets in
 * URLs or payloads are not written to logs.
 *
 * User-Agent is parsed for analytics (browser/device) but no IP addresses,
 * cookies, or auth tokens are captured.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();
  let logged = false;

  const writeLog = (): void => {
    if (logged) return;
    logged = true;

    const durationNs = process.hrtime.bigint() - start;
    const responseTimeMs = Number(durationNs) / 1e6;

    // Propagate trace_id from the incoming request header when available so
    // all log lines for a single request share the same distributed trace id.
    const traceId =
      (req.headers["x-trace-id"] as string | undefined) ??
      (req.headers["x-request-id"] as string | undefined);

    const reqLogger = traceId ? childLogger(traceId) : logger;

    reqLogger.info({
      event: { dataset: "http.request" },
      method: req.method,
      path: loggedPath(req),
      statusCode: res.statusCode,
      responseTimeMs: Math.round(responseTimeMs * 1000) / 1000,
      http: {
        request: { method: req.method },
        response: { status_code: res.statusCode },
      },
      userAgent: parseUserAgent(req.headers["user-agent"]),
    });
  };

  res.on("finish", writeLog);
  res.on("close", writeLog);

  const traceId =
    (req.headers["x-trace-id"] as string | undefined) ??
    (req.headers["x-request-id"] as string | undefined);

  if (traceId) {
    requestContext.run({ trace_id: traceId }, () => next());
  } else {
    next();
  }
}
