/**
 * OpenTelemetry context propagation across queue boundaries.
 *
 * The HTTP edge and the queue workers run in separate contexts (and often in
 * separate processes), so the ambient OTel context cannot travel on its own.
 * This module serialises the active W3C `traceparent` into job data on the
 * producer side and re-hydrates it on the consumer side, giving a single trace
 * waterfall across:
 *
 *   HTTP request → enqueue → BullMQ/NATS → job processor → downstream spans
 *
 * Usage — enqueue side:
 *   import { injectTraceContext } from "./jobTracing";
 *   await queue.add(jobName, injectTraceContext(data));
 *
 * Usage — worker side:
 *   import { withJobTrace } from "./jobTracing";
 *   await withJobTrace("queue.transaction.process", job.data, () => run(job));
 */

import {
  Attributes,
  context,
  Context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { TRACE_ID_KEY } from "./trace";

/** Job-data key carrying the serialized W3C `traceparent` header. */
export const TRACEPARENT_KEY = "_traceparent" as const;

/** Tracer used for all queue consumer spans. */
const QUEUE_TRACER_NAME = "mobile-money.queue";

type JobData = object | undefined;

/**
 * Returns a shallow copy of `data` carrying the active trace context.
 *
 * When there is an active span (e.g. the enqueue happens inside an HTTP
 * handler) the W3C `traceparent` is embedded under {@link TRACEPARENT_KEY} so
 * the consumer can continue the same trace. A legacy `_traceId` is only added
 * when the producer did not already set one, keeping log correlation working
 * for jobs enqueued outside a request.
 */
export function injectTraceContext<T extends object>(data: T): T {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  if (!carrier.traceparent) {
    return data;
  }

  const source = data as Record<string, unknown>;
  const injected: Record<string, unknown> = {
    ...source,
    [TRACEPARENT_KEY]: carrier.traceparent,
  };

  if (source[TRACE_ID_KEY] === undefined) {
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext && spanContext.traceId) {
      injected[TRACE_ID_KEY] = spanContext.traceId;
    }
  }

  return injected as T;
}

/**
 * Rebuilds the producer's context from job data.
 * Falls back to the current context when no `traceparent` was propagated
 * (jobs enqueued before propagation was added, or scheduled/cron jobs).
 */
export function extractTraceContext(data: JobData): Context {
  const traceparent = (data as Record<string, unknown> | undefined)?.[
    TRACEPARENT_KEY
  ];
  if (typeof traceparent === "string" && traceparent.includes("-")) {
    return propagation.extract(context.active(), { traceparent });
  }
  return context.active();
}

/**
 * Runs `fn` inside a CONSUMER span whose parent is the producer's span.
 *
 * The span records job attributes, exceptions and status, and always ends.
 * Errors are re-thrown so queue retry/DLQ semantics are unchanged.
 */
export async function withJobTrace<T>(
  spanName: string,
  data: JobData,
  fn: () => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  const parentContext = extractTraceContext(data);
  const tracer = trace.getTracer(QUEUE_TRACER_NAME);

  return context.with(parentContext, () =>
    tracer.startActiveSpan(
      spanName,
      { kind: SpanKind.CONSUMER, attributes },
      async (span) => {
        try {
          const result = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          throw err;
        } finally {
          span.end();
        }
      },
    ),
  );
}
