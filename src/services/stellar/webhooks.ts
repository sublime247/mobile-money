import { Queue, Worker, Job } from "bullmq";
import { createHmac } from "crypto";
import { queueOptions } from "../../queue/config";

export const SEP_WEBHOOK_QUEUE_NAME = "sep-webhooks";

export interface SepWebhookJobData {
  transactionId: string;
  status: string;
  callbackUrl: string;
  payload: any;
}

export const sepWebhookQueue = new Queue<SepWebhookJobData>(
  SEP_WEBHOOK_QUEUE_NAME,
  queueOptions
);

/**
 * Enqueue a webhook job for a SEP transaction status change.
 */
export async function enqueueSepWebhook(
  transactionId: string,
  status: string,
  callbackUrl: string,
  payload: any
): Promise<void> {
  if (!callbackUrl) {
    console.warn(`[sep-webhook] Skipped enqueuing webhook for transaction ${transactionId}: No callback URL provided`);
    return;
  }

  const jobId = `sep-webhook-${transactionId}-${status}-${Date.now()}`;
  await sepWebhookQueue.add(
    "send-webhook",
    {
      transactionId,
      status,
      callbackUrl,
      payload,
    },
    {
      jobId,
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
    }
  );
  console.log(`[sep-webhook] Enqueued webhook job ${jobId} for transaction ${transactionId} (status: ${status}) to ${callbackUrl}`);
}

/**
 * BullMQ Worker to process SEP webhook delivery.
 */
export const sepWebhookWorker = new Worker<SepWebhookJobData>(
  SEP_WEBHOOK_QUEUE_NAME,
  async (job: Job<SepWebhookJobData>) => {
    const { transactionId, status, callbackUrl, payload } = job.data;
    const secret = process.env.STELLAR_WEBHOOK_SECRET || "default_secret";

    const bodyStr = JSON.stringify(payload);
    const signature = "sha256=" + createHmac("sha256", secret).update(bodyStr).digest("hex");

    console.log(`[sep-webhook] Delivering webhook job=${job.id} for transaction=${transactionId} status=${status} to callbackUrl=${callbackUrl}`);
    console.log(`[sep-webhook] Request Body: ${bodyStr}`);

    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stellar-Signature": signature,
        },
        body: bodyStr,
      });

      const responseText = await response.text();
      console.log(`[sep-webhook] Response status=${response.status} body=${responseText}`);

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${responseText}`);
      }
    } catch (error: any) {
      console.error(`[sep-webhook] Delivery failed for transaction=${transactionId} callbackUrl=${callbackUrl}:`, error.message);
      throw error; // Propagate error so BullMQ retries the job
    }
  },
  queueOptions
);

// Graceful shutdown helper
export async function closeSepWebhookWorker() {
  await sepWebhookWorker.close();
  await sepWebhookQueue.close();
}
