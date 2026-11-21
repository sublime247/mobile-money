import { Job, Worker } from "bullmq";
import {
  RECEIVING_ANCHOR_WEBHOOK_QUEUE,
  ReceivingAnchorWebhookJob,
  WebhookDispatcherService,
} from "../services/webhookService";
import { queueOptions } from "./config";
import logger from "../utils/logger";
import { Context, context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { withJobTrace } from "./jobTracing";

const defaultPropagator = new W3CTraceContextPropagator();

/**
 * Serializes active OpenTelemetry trace context (W3C traceparent, tracestate, baggage)
 * into an outgoing HTTP header map.
 */
export function serializeTraceHeaders(
  ctx: Context = context.active(),
): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  if (!carrier.traceparent) {
    defaultPropagator.inject(ctx, carrier, {
      set: (c, k, v) => {
        c[k] = v;
      },
    });
  }
  return carrier;
}

/**
 * Returns the serialized W3C traceparent header string from the given or active context.
 */
export function serializeTraceparent(
  ctx: Context = context.active(),
): string | undefined {
  const carrier = serializeTraceHeaders(ctx);
  return carrier.traceparent;
}

/**
 * Wraps webhook delivery in an OpenTelemetry consumer span, ensuring trace context
 * is propagated and logged alongside the delivery attempt in audit records.
 */
export async function deliverWebhookWithTracing(
  jobData: ReceivingAnchorWebhookJob,
  dispatcher: WebhookDispatcherService = new WebhookDispatcherService(),
): Promise<void> {
  return withJobTrace(
    "queue.receivingAnchorWebhook.deliver",
    jobData,
    async () => {
      const activeCtx = context.active();
      const traceHeaders = serializeTraceHeaders(activeCtx);
      const span = trace.getActiveSpan();
      const traceparent = traceHeaders.traceparent ?? jobData._traceparent;
      const traceId =
        span?.spanContext().traceId ??
        (traceparent ? traceparent.split("-")[1] : undefined) ??
        jobData._traceId;

      logger.info(
        {
          transactionId: jobData.payload?.id,
          status: jobData.payload?.status,
          traceId,
          traceparent,
        },
        "Receiving-anchor webhook delivery attempt",
      );

      await dispatcher.deliver(jobData);
    },
    {
      "messaging.system": "bullmq",
      "messaging.destination": RECEIVING_ANCHOR_WEBHOOK_QUEUE,
      "webhook.id": jobData.payload?.id,
    },
  );
}

let worker: Worker<ReceivingAnchorWebhookJob> | null = null;

export function startReceivingAnchorWebhookWorker(): void {
  if (worker) return;

  const dispatcher = new WebhookDispatcherService();
  worker = new Worker<ReceivingAnchorWebhookJob>(
    RECEIVING_ANCHOR_WEBHOOK_QUEUE,
    async (job: Job<ReceivingAnchorWebhookJob>) =>
      deliverWebhookWithTracing(job.data, dispatcher),
    queueOptions,
  );
  worker.on("failed", (job, error) => {
    const traceId =
      job?.data?._traceId ??
      (job?.data?._traceparent
        ? job.data._traceparent.split("-")[1]
        : undefined);
    logger.warn(
      { jobId: job?.id, attemptsMade: job?.attemptsMade, traceId, error },
      "Receiving-anchor webhook delivery failed; BullMQ will retry with exponential backoff",
    );
  });
}

export async function closeReceivingAnchorWebhookWorker(): Promise<void> {
  await worker?.close();
  worker = null;
}
