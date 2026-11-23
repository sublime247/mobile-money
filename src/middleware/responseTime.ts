/**
 * Response-time middleware — issue #2287
 *
 * Attaches a high-resolution timer at the very start of each request and
 * injects the elapsed duration as the `X-Response-Time` header (e.g. "142ms")
 * before the response is flushed to the client.
 *
 * Emits a WARN-level log when the total request duration exceeds the
 * configurable SLA threshold (default 2 000 ms).
 */

import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";

/** SLA threshold in milliseconds — log a warning when exceeded. */
const SLA_THRESHOLD_MS = parseInt(
  process.env.RESPONSE_TIME_SLA_MS ?? "2000",
  10,
);

/**
 * Formats a nanosecond BigInt duration as a millisecond string rounded to
 * one decimal place (e.g. `"142.3ms"`).
 */
function formatDuration(ns: bigint): string {
  const ms = Number(ns) / 1_000_000;
  return `${ms.toFixed(1)}ms`;
}

/**
 * Parses the formatted duration string back to a numeric milliseconds value.
 * Used internally for SLA comparison.
 */
function parseDurationMs(formatted: string): number {
  return parseFloat(formatted);
}

export const responseTime = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Capture start time with nanosecond resolution immediately.
  const startNs = process.hrtime.bigint();

  /**
   * Intercept the moment headers are written so we always inject
   * X-Response-Time even when the response body is streamed or the route
   * calls res.end() directly instead of res.send().
   */
  const writeHead = res.writeHead.bind(res) as typeof res.writeHead;

  (res as any).writeHead = function (
    statusCode: number,
    ...args: any[]
  ): Response {
    const durationStr = formatDuration(process.hrtime.bigint() - startNs);
    res.setHeader("X-Response-Time", durationStr);

    const durationMs = parseDurationMs(durationStr);
    if (durationMs > SLA_THRESHOLD_MS) {
      logger.warn(
        {
          method: req.method,
          url: req.originalUrl ?? req.url,
          statusCode,
          durationMs,
          slaThresholdMs: SLA_THRESHOLD_MS,
        },
        `[responseTime] SLA breach: ${durationStr} > ${SLA_THRESHOLD_MS}ms`,
      );
    }

    return writeHead(statusCode, ...args);
  };

  next();
};
