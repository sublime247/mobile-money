import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const WEBHOOK_RETRY_QUEUE_NAME = "webhook-callback-retries";

export interface WebhookRetryJobData {
  webhookId: string;
  userId: string;
  url: string;
  secret: string;
  eventType: string;
  payload: Record<string, unknown>;
  useFlatPayload?: boolean;
}

export const webhookRetryQueue = new Queue<WebhookRetryJobData>(
  WEBHOOK_RETRY_QUEUE_NAME,
  queueOptions,
);

const MAX_ATTEMPTS = Number(process.env.WEBHOOK_RETRY_MAX_ATTEMPTS ?? 5);
// Base delay for exponential backoff in ms (default 30s → 30s, 60s, 120s, 240s, 480s)
const BASE_DELAY_MS = Number(process.env.WEBHOOK_RETRY_BASE_DELAY_MS ?? 30_000);

export async function enqueueWebhookRetry(data: WebhookRetryJobData): Promise<void> {
  await webhookRetryQueue.add("deliver", data, {
    attempts: MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: BASE_DELAY_MS },
    removeOnComplete: { count: 200, age: 7 * 24 * 3600 },
    removeOnFail: { count: 500, age: 30 * 24 * 3600 },
  });
}

export async function closeWebhookRetryQueue(): Promise<void> {
  await webhookRetryQueue.close();
}
