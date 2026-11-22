/**
 * src/queue/correlationContext.ts
 *
 * Correlation-ID propagation from HTTP requests through BullMQ jobs (#2381).
 *
 * src/middleware/correlationId.ts already runs every HTTP request inside an
 * AsyncLocalStorage context (`requestContext` from utils/logger.ts) so every
 * Winston log line during that request is auto-stamped with correlation_id,
 * and src/utils/correlationIdInterceptor.ts already forwards it on outgoing
 * Axios/fetch calls made *during* that request.
 *
 * None of that reaches a BullMQ job: a worker processes the job in its own
 * async context (often its own process entirely), so the producer's
 * AsyncLocalStorage store is gone by the time the job runs. This module
 * closes that gap:
 *
 *   - injectCorrelationId(data)   — enqueue side: stamp the active
 *     correlation ID (or generate one) onto the job payload.
 *   - withJobCorrelationContext(data, fn) — worker side: re-run `fn` inside
 *     a fresh requestContext carrying that correlation ID, so every log
 *     line fn writes is auto-stamped exactly like an HTTP-request log line,
 *     and any outgoing provider HTTP call fn makes through
 *     attachCorrelationIdInterceptor()/withCorrelationId() picks it up too
 *     (both read the same requestContext via getCurrentCorrelationId()).
 *
 * This is independent of src/queue/jobTracing.ts, which propagates the
 * OpenTelemetry `traceparent` (a different, OTel-specific identifier) for
 * distributed tracing spans — correlation_id is the app's own log-grouping
 * ID, used by Winston and threaded through provider calls. Both can be
 * present on the same job.
 */

import { randomUUID } from "crypto";
import { requestContext } from "../utils/logger";
import { getCurrentCorrelationId } from "../middleware/correlationId";

/** Job-data key carrying the propagated correlation ID. */
export const JOB_CORRELATION_ID_KEY = "_correlationId" as const;

/**
 * Returns a shallow copy of `data` carrying the active request's
 * correlation ID under {@link JOB_CORRELATION_ID_KEY}. When called outside
 * a request context (e.g. a cron job or script enqueueing work), a fresh
 * UUID is generated so the job is still traceable end-to-end.
 *
 * Usage — enqueue side:
 *   await queue.add(jobName, injectCorrelationId(data));
 */
export function injectCorrelationId<T extends Record<string, unknown>>(
  data: T,
): T & { [JOB_CORRELATION_ID_KEY]: string } {
  const correlationId = getCurrentCorrelationId() ?? randomUUID();
  return { ...data, [JOB_CORRELATION_ID_KEY]: correlationId };
}

/**
 * Extracts the correlation ID previously injected by
 * `injectCorrelationId()`. Returns `undefined` for jobs enqueued before
 * propagation was added — callers should fall back to generating a fresh
 * one rather than leaving logs unstamped.
 */
export function correlationIdFromJob(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) return undefined;
  const val = data[JOB_CORRELATION_ID_KEY];
  return typeof val === "string" ? val : undefined;
}

/**
 * Runs `fn` inside a requestContext carrying the job's correlation ID (or a
 * freshly generated one if the job predates propagation), so that:
 *   - every Winston log line fn writes is auto-stamped with correlation_id
 *     via the same `enrichInfo()` mechanism as an HTTP request, and
 *   - any outgoing HTTP call fn makes via attachCorrelationIdInterceptor()
 *     or withCorrelationId() automatically carries the X-Correlation-ID
 *     header, exactly as it would mid-request.
 *
 * Usage — worker side:
 *   await withJobCorrelationContext(job.data, () => processJob(job));
 */
export async function withJobCorrelationContext<T>(
  data: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const correlationId = correlationIdFromJob(data) ?? randomUUID();
  const existingStore = requestContext.getStore();

  return requestContext.run(
    {
      trace_id: existingStore?.trace_id ?? correlationId,
      correlation_id: correlationId,
    },
    fn,
  );
}
