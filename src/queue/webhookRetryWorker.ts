import { Worker, Job } from "bullmq";
import { webhookRetryQueue, WebhookRetryJobData } from "./webhookRetryQueue";
import { WebhookService, WebhookEvent } from "../services/webhook";
import { TransactionModel } from "../models/transaction";
import logger from "../utils/logger";
import { queueOptions } from "./config";

let webhookRetryWorker: Worker<WebhookRetryJobData> | null = null;

export function startWebhookRetryWorker(): void {
  if (webhookRetryWorker) {
    return;
  }

  const transactionModel = new TransactionModel();
  const webhookService = new WebhookService();

  webhookRetryWorker = new Worker<WebhookRetryJobData>(
    "webhook-callback-retries",
    async (job: Job<WebhookRetryJobData>) => {
      const { webhookId, userId, url, secret, eventType, payload, useFlatPayload } = job.data;

      logger.info({ webhookId, eventType, attempt: job.attemptsMade }, "Processing webhook retry job");

      try {
        const transaction = await transactionModel.findById(webhookId);
        if (!transaction) {
          logger.warn({ webhookId }, "Webhook retry: transaction not found, skipping");
          return;
        }

        const retryService = new WebhookService({
          webhookUrl: url,
          webhookSecret: secret,
          maxAttempts: 1,
          baseDelayMs: 0,
        });

        const result = useFlatPayload
          ? await retryService.sendFlatTransactionEvent(eventType as WebhookEvent, transaction)
          : await retryService.sendTransactionEvent(eventType as WebhookEvent, transaction);

        if (result.status === "delivered") {
          logger.info({ webhookId, eventType }, "Webhook retry delivered successfully");
        } else {
          logger.warn(
            { webhookId, eventType, status: result.status, error: result.lastError },
            "Webhook retry failed after processing",
          );
          throw new Error(result.lastError || "Webhook delivery failed");
        }
      } catch (error) {
        logger.error({ webhookId, eventType, error }, "Webhook retry job failed");
        throw error;
      }
    },
    {
      ...queueOptions,
      concurrency: 5,
    },
  );

  webhookRetryWorker.on("completed", (job) => {
    logger.info({ jobId: job?.id }, "Webhook retry job completed");
  });

  webhookRetryWorker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, "Webhook retry job failed");
  });

  logger.info("Webhook retry worker started");
}

export async function closeWebhookRetryWorker(): Promise<void> {
  if (!webhookRetryWorker) {
    return;
  }

  await webhookRetryWorker.close();
  webhookRetryWorker = null;
  logger.info("Webhook retry worker closed");
}
