import { Queue, Worker, Job } from "bullmq";
import { createHmac } from "crypto";
import { EventEmitter } from "events";
import logger from "../utils/logger";
import { queueOptions } from "./config";
import { handleFailedJob } from "../config/queue";
import { validateWebhookUrl, SsrfBlockedError } from "../security/ssrf";
import { signWebhookPayload } from "../crypto/webhookSigning";

export const CALLBACK_QUEUE_NAME = "sep24-callback-retries";
export const MAX_CALLBACK_ATTEMPTS = 5;

/**
 * 5-attempt retry backoff schedule:
 * 10s, 30s, 2m, 10m, 30m
 */
export const SEP24_CALLBACK_BACKOFF_SCHEDULE_MS = [
  10_000, // 10s
  30_000, // 30s
  120_000, // 2m (120s)
  600_000, // 10m (600s)
  1_800_000, // 30m (1800s)
];

export function getCallbackBackoffDelay(
  attemptsMade: number,
  jitter: boolean = false,
): number {
  if (attemptsMade <= 0) {
    return SEP24_CALLBACK_BACKOFF_SCHEDULE_MS[0];
  }
  const index = Math.min(
    attemptsMade - 1,
    SEP24_CALLBACK_BACKOFF_SCHEDULE_MS.length - 1,
  );
  const baseDelay = SEP24_CALLBACK_BACKOFF_SCHEDULE_MS[index];
  if (!jitter) {
    return baseDelay;
  }
  // Up to +/- 10% jitter
  const jitterRange = baseDelay * 0.1;
  const jitterOffset = (Math.random() * 2 - 1) * jitterRange;
  return Math.round(baseDelay + jitterOffset);
}

export interface Sep24CallbackJobData {
  transactionId: string;
  status: string;
  callbackUrl: string;
  payload: any;
  timestamp?: string;
  attemptsMade?: number;
}

export interface Sep24StatusChangeEvent {
  transactionId: string;
  status: string;
  callbackUrl?: string;
  transaction?: any;
}

export const callbackQueue = new Queue<Sep24CallbackJobData, any, string>(
  CALLBACK_QUEUE_NAME,
  queueOptions,
);

/**
 * Records exhausted callback delivery attempts to dead-letter log and failed_jobs.
 */
export async function handleExhaustedCallback(
  job: Job<Sep24CallbackJobData, any, string> | undefined,
  error: Error | any,
): Promise<void> {
  if (!job) {
    return;
  }
  if ((job as any).__dlqHandled) {
    return;
  }
  (job as any).__dlqHandled = true;

  const data = job.data;
  const transactionId = data?.transactionId || "unknown";
  const callbackUrl = data?.callbackUrl || "unknown";
  const attemptsMade = job.attemptsMade || MAX_CALLBACK_ATTEMPTS;
  const errorMessage = error?.message || String(error);

  logger.error(
    `[DLQ] Dead-letter log: exhausted delivery attempts (${attemptsMade}/${MAX_CALLBACK_ATTEMPTS}) for callback on transaction ${transactionId} to ${callbackUrl}. Error: ${errorMessage}`,
    {
      jobId: job.id,
      transactionId,
      callbackUrl,
      attemptsMade,
      error: errorMessage,
      exhausted: true,
      failedAt: new Date().toISOString(),
    },
  );

  try {
    await handleFailedJob(job as any, error, CALLBACK_QUEUE_NAME);
  } catch (err) {
    logger.warn(
      "[DLQ] Failed to route exhausted callback to failed_jobs storage:",
      err,
    );
  }
}

/**
 * Executes HTTP delivery of a callback webhook payload to the client URL.
 */
export async function deliverCallback(
  data: Sep24CallbackJobData,
): Promise<{ status: number; body: string }> {
  const { transactionId, status, callbackUrl, payload } = data;
  if (!callbackUrl) {
    throw new Error("Missing callbackUrl");
  }

  // SSRF check
  await validateWebhookUrl(callbackUrl);

  const secret = process.env.STELLAR_WEBHOOK_SECRET || "default_secret";
  const bodyStr = JSON.stringify(
    payload || { transaction_id: transactionId, status },
  );
  const signed = signWebhookPayload(
    bodyStr,
    (p) => "sha256=" + createHmac("sha256", secret).update(p).digest("hex"),
    process.env.STELLAR_WEBHOOK_ED25519_SIGNING_KEY,
  );

  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Stellar-Signature": signed.signature,
    },
    body: bodyStr,
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Callback delivery failed with HTTP ${response.status}: ${responseText}`,
    );
  }

  return { status: response.status, body: responseText };
}

/**
 * Enqueues a failed or initial callback delivery to the retry queue.
 */
export async function enqueueCallbackRetry(
  data: Sep24CallbackJobData,
): Promise<Job<Sep24CallbackJobData, any, string> | null> {
  if (!data.callbackUrl) {
    logger.warn(
      `[sep24-callback] Skipped callback for transaction ${data.transactionId}: No callback URL provided`,
    );
    return null;
  }

  try {
    await validateWebhookUrl(data.callbackUrl);
  } catch (err) {
    logger.warn(
      `[sep24-callback] Skipped callback for transaction ${data.transactionId}: ${
        err instanceof SsrfBlockedError ? err.message : String(err)
      }`,
    );
    return null;
  }

  const jobId = `sep24-cb-${data.transactionId}-${data.status}-${Date.now()}`;
  const job = await callbackQueue.add("deliver-callback", data, {
    jobId,
    attempts: MAX_CALLBACK_ATTEMPTS,
    backoff: {
      type: "custom",
    },
    removeOnComplete: { count: 500, age: 7 * 24 * 3600 },
    removeOnFail: false, // Keep in queue for DLQ inspection
  });

  logger.info(
    `[sep24-callback] Enqueued callback retry job ${jobId} for transaction ${data.transactionId} (status: ${data.status}) to ${data.callbackUrl}`,
  );

  return job;
}

/**
 * Connects SEP-24 transaction status change emitter to the callback retry queue dispatcher.
 */
export function registerSep24CallbackDispatcher(emitter: EventEmitter): void {
  if (emitter.listenerCount("statusChange") > 0) {
    return;
  }
  emitter.on("statusChange", async (event: Sep24StatusChangeEvent) => {
    if (event.callbackUrl) {
      try {
        await enqueueCallbackRetry({
          transactionId: event.transactionId,
          status: event.status,
          callbackUrl: event.callbackUrl,
          payload: event.transaction || {
            transaction_id: event.transactionId,
            status: event.status,
          },
        });
      } catch (err: any) {
        logger.error(
          `[sep24-callback] Failed to dispatch callback retry for transaction ${event.transactionId}: ${err?.message || err}`,
        );
      }
    }
  });
}

/**
 * BullMQ Worker processing callback retries.
 */
export const callbackWorker = new Worker<Sep24CallbackJobData, any, string>(
  CALLBACK_QUEUE_NAME,
  async (job: Job<Sep24CallbackJobData, any, string>) => {
    try {
      await deliverCallback(job.data);
      logger.info(
        `[sep24-callback] Delivered callback successfully for transaction ${job.data.transactionId}`,
      );
    } catch (err: any) {
      logger.warn(
        `[sep24-callback] Delivery attempt ${job.attemptsMade}/${MAX_CALLBACK_ATTEMPTS} failed for transaction ${job.data.transactionId}: ${err.message}`,
      );

      if (job.attemptsMade >= MAX_CALLBACK_ATTEMPTS) {
        await handleExhaustedCallback(job, err);
      }

      throw err;
    }
  },
  {
    ...queueOptions,
    settings: {
      ...queueOptions?.settings,
      backoffStrategy: (attemptsMade: number) =>
        getCallbackBackoffDelay(attemptsMade),
    },
  },
);

callbackWorker.on(
  "failed",
  async (
    job: Job<Sep24CallbackJobData, any, string> | undefined,
    err: Error,
  ) => {
    if (job && job.attemptsMade >= MAX_CALLBACK_ATTEMPTS) {
      await handleExhaustedCallback(job, err);
    }
  },
);

export async function closeCallbackQueue(): Promise<void> {
  await callbackWorker.close();
  await callbackQueue.close();
}
