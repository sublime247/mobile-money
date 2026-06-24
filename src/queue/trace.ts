/**
 * Trace-ID propagation for queue workers.
 *
 * Ensures that a trace ID generated (or received) at the HTTP edge is carried
 * through every queue job so that worker logs can be correlated back to the
 * originating request.
 *
 * Usage — enqueue side (e.g. inside a route handler or service):
 *   import { withTraceId } from "../queue/trace";
 *   await addTransactionJob(withTraceId(req, { transactionId, ... }));
 *
 * Usage — worker side:
 *   import { traceIdFromJob, childLoggerWithTrace } from "../queue/trace";
 *   const log = childLoggerWithTrace(job.data);
 *   log.info("processing job");
 */

import { childLogger } from "../utils/logger";

/** The key used inside job data objects to carry the trace ID. */
export const TRACE_ID_KEY = "_traceId" as const;

/**
 * Returns a shallow copy of `data` with the trace ID extracted from the
 * incoming HTTP request appended.  If no trace header is present, a random
 * UUID is generated so every job is still traceable.
 *
 * `req` should be an Express Request (or any object with a `headers` map).
 * It is typed loosely to avoid a hard dependency on `express` types.
 */
export function withTraceId<T extends Record<string, unknown>>(
  req: { headers: Record<string, string | string[] | undefined> } | undefined,
  data: T,
): T & { [TRACE_ID_KEY]: string } {
  const traceId =
    (req?.headers["x-trace-id"] as string | undefined) ??
    (req?.headers["x-request-id"] as string | undefined) ??
    crypto.randomUUID();

  return { ...data, [TRACE_ID_KEY]: traceId };
}

/**
 * Extracts the trace ID from a job data object (BullMQ `job.data` or
 * RabbitMQ message payload).  Returns `undefined` when the job was enqueued
 * before trace propagation was added.
 */
export function traceIdFromJob(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) return undefined;
  const val = data[TRACE_ID_KEY];
  return typeof val === "string" ? val : undefined;
}

/**
 * Creates a child logger pre-bound to the trace ID carried by the job.
 * Falls back to the root logger when no trace ID is present.
 */
export function childLoggerWithTrace(
  data: Record<string, unknown> | undefined,
) {
  const traceId = traceIdFromJob(data);
  return traceId ? childLogger(traceId) : undefined;
}

/**
 * Propagates the trace ID from a parent job's data to a new child job's data.
 * If the parent job contains a trace ID (via TRACE_ID_KEY), it is copied
 * into the child data. Otherwise a new UUID is generated ensuring the child
 * job remains traceable.
 */
export function withParentTrace<T extends Record<string, unknown>>(
  parentData: Record<string, unknown> | undefined,
  childData: T,
): T & { [TRACE_ID_KEY]: string } {
  const existingTraceId = traceIdFromJob(parentData);
  const traceId = existingTraceId ?? crypto.randomUUID();
  return { ...childData, [TRACE_ID_KEY]: traceId } as any;
}
