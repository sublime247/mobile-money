import logger from "../utils/logger";
import { Queue, Worker, Job } from "bullmq";
import { queueOptions } from "./config";
import { signWebhookPayload } from "../crypto/webhookSigning";
import { validateWebhookUrl } from "../security/ssrf";
import { createHmac } from "crypto";

export const CALLBACK_QUEUE_NAME = "sep24-callback-retries";

export interface CallbackJobData {
  transactionId: string;
  status: string;
  callbackUrl: string;
  payload: Record<string, unknown>;
}

// 5 attempts backoff schedule: 10s, 30s, 2m, 10m, 30m
export const CALLBACK_RETRY_SCHEDULE_MS = [
  10_000,    // 10s
  30_000,    // 30s
  120_000,   // 2m
  600_000,   // 10m
  1_800_000, // 30m
];

/**
 * Calculates jittered backoff delay for an attempt (1-indexed attempt number).
 */
export function getCallbackBackoffDelay(attemptsMade: number): number {
  const index = Math.min(
    Math.max(0, attemptsMade - 1),
    CALLBACK_RETRY_SCHEDULE_MS.length - 1,
  );
  const baseDelay = CALLBACK_RETRY_SCHEDULE_MS[index];
  // Add up to 10% jitter to avoid thundering herd
  const jitter = Math.floor(Math.random() * (baseDelay * 0.1));
  return baseDelay + jitter;
}

export const callbackQueue = new Queue<CallbackJobData, void, string>(
  CALLBACK_QUEUE_NAME,
  queueOptions,
);

export async function enqueueCallbackRetry(
  data: CallbackJobData,
): Promise<void> {
  const jobId = `sep24-cb-${data.transactionId}-${data.status}-${Date.now()}`;
  await callbackQueue.add("deliver-callback", data, {
    jobId,
    attempts: 5,
    backoff: {
      type: "sep24ExponentialJitter",
    },
    removeOnComplete: { count: 200, age: 7 * 24 * 3600 },
    removeOnFail: { count: 500, age: 30 * 24 * 3600 },
  });
}

/**
 * BullMQ Worker to process SEP-24 callback delivery and handle dead-letter exhaust.
 */
export const callbackWorker = new Worker<CallbackJobData>(
  CALLBACK_QUEUE_NAME,
  async (job: Job<CallbackJobData>) => {
    const { transactionId, callbackUrl, payload } = job.data;
    const secret = process.env.STELLAR_WEBHOOK_SECRET || "default_secret";

    const bodyStr = JSON.stringify(payload);
    const signature = signWebhookPayload(
      bodyStr,
      (p) => "sha256=" + createHmac("sha256", secret).update(p).digest("hex"),
      process.env.STELLAR_WEBHOOK_ED25519_SIGNING_KEY,
    ).signature;

    try {
      await validateWebhookUrl(callbackUrl);
    } catch (error: any) {
      logger.error(
        { transactionId, callbackUrl, error: error.message },
        `[sep24-callback] Blocked delivery by SSRF policy`,
      );
      return; // permanent failure, do not retry
    }

    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stellar-Signature": signature,
        },
        body: bodyStr,
      });

      if (!response.ok) {
        throw new Error(
          `HTTP error ${response.status}: ${await response.text()}`,
        );
      }
    } catch (error: any) {
      logger.warn(
        {
          transactionId,
          callbackUrl,
          attempt: job.attemptsMade,
          error: error.message,
        },
        `[sep24-callback] Attempt failed, enqueuing retry`,
      );
      throw error;
    }
  },
  {
    ...queueOptions,
    settings: {
      backoffStrategies: {
        sep24ExponentialJitter: (attemptsMade: number) => {
          return getCallbackBackoffDelay(attemptsMade);
        },
      },
    },
  },
);

// Dead-letter log listener for exhausted attempts
callbackWorker.on(
  "failed",
  (job: Job<CallbackJobData> | undefined, error: Error) => {
    if (job && job.attemptsMade >= (job.opts.attempts || 5)) {
      logger.error(
        {
          deadLetter: true,
          transactionId: job.data.transactionId,
          callbackUrl: job.data.callbackUrl,
          status: job.data.status,
          attemptsMade: job.attemptsMade,
          error: error.message,
        },
        `[sep24-callback] Dead-letter log: Exhausted delivery attempts after max retries`,
      );
    }
  },
);

export async function closeCallbackQueue(): Promise<void> {
  await callbackWorker.close();
  await callbackQueue.close();
}
