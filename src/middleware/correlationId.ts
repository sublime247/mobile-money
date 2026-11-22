import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";
import { requestContext } from "../utils/logger";

export const CORRELATION_ID_HEADER = "x-correlation-id";

export interface RequestWithCorrelationId extends Request {
  correlationId: string;
}

/**
 * Reads X-Correlation-ID from the incoming request, or generates a UUIDv4
 * when absent, then:
 * - echoes it back on the response so callers can log/trace by it too,
 * - attaches it to `req.correlationId` for direct use in route handlers,
 * - runs the rest of the request inside `requestContext` (AsyncLocalStorage),
 *   so every Winston log line written during this request is automatically
 *   stamped with `correlation_id` via `enrichInfo()` in `utils/logger.ts` -
 *   no need to thread it through every log call manually.
 *
 * A correlation ID identifies one logical request as it crosses service and
 * provider boundaries. It is distinct from `X-Request-ID` (`requestId.ts`),
 * which identifies a single hop.
 */
export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  const correlationId =
    (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();

  (req as RequestWithCorrelationId).correlationId = correlationId;
  res.setHeader("X-Correlation-ID", correlationId);

  const existingStore = requestContext.getStore();
  requestContext.run(
    { trace_id: existingStore?.trace_id ?? correlationId, correlation_id: correlationId },
    () => next(),
  );
}

/**
 * Reads the correlation ID for the current request, for use in code paths
 * that don't have direct access to `req` (e.g. a service or provider client
 * called several layers deep). Returns `undefined` outside of a request
 * handled by `correlationIdMiddleware`.
 */
export function getCurrentCorrelationId(): string | undefined {
  return requestContext.getStore()?.correlation_id;
}
