/**
 * Dynamic request timeout middleware with context cancellation support.
 *
 * Unlike `middleware/timeout.ts` (which only flags `req.timedout` for
 * handlers to check cooperatively, via `connect-timeout`), this attaches a
 * real `AbortSignal` to the request so that handlers can pass it straight
 * through to cancellable work — a `queryRead`/`queryWrite` call or a
 * provider HTTP request — and have that work actually stop, not just get
 * ignored after the fact.
 *
 * On timeout:
 *   - If response headers have not been sent yet, responds 504 Gateway
 *     Timeout and aborts `req.abortSignal`.
 *   - If headers were already sent (streaming response in progress), only
 *     aborts the signal; the client has already started receiving a 200.
 */

import { Request, Response, NextFunction } from "express";

export interface RequestTimeoutOptions {
  /** Timeout in milliseconds before the request is aborted. */
  timeoutMs: number;
}

export function requestTimeout(options: RequestTimeoutOptions) {
  const { timeoutMs } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const controller = new AbortController();
    req.abortSignal = controller.signal;

    const timer = setTimeout(() => {
      controller.abort();

      if (!res.headersSent) {
        res.status(504).json({
          error: "Gateway Timeout",
          message: `Request exceeded the ${timeoutMs}ms timeout`,
          code: "REQUEST_TIMEOUT",
        });
      }
    }, timeoutMs);

    const clear = () => clearTimeout(timer);
    res.once("finish", clear);
    res.once("close", clear);

    next();
  };
}

/**
 * Preset timeouts for common operation classes. Mirrors
 * `middleware/timeout.ts`'s `TimeoutPresets` naming so route files can
 * switch between the two without guessing new names, but these actually
 * cancel downstream work via `req.abortSignal`.
 */
export const RequestTimeoutPresets = {
  /** 15s — standard single-record reads/writes. */
  standard: requestTimeout({ timeoutMs: 15_000 }),
  /** 30s — complex batch operations spanning multiple records/providers. */
  complexBatch: requestTimeout({ timeoutMs: 30_000 }),
};
