import { Message as AmqpMessage } from "amqplib";
import { TransactionJobData, TransactionJobResult } from "./transactionQueue";
import { rabbitMQManager, EXCHANGES, ROUTING_KEYS, QUEUES } from "./rabbitmq";
import {
  natsManager,
  NATS_QUEUE_ENABLED,
  NATS_SUBJECT,
  NATS_DURABLE_CONSUMER,
  NATS_CONSUMER_GROUP,
} from "./nats";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { StellarService } from "../services/stellar/stellarService";
import * as highThroughputService from "../services/stellar/highThroughputService";
import { UserModel } from "../models/users";
import { EmailService } from "../services/email";
import { withRetry } from "../services/retry";
import { notifyTransactionWebhook, WebhookService } from "../services/webhook";
import { smsService } from "../services/sms";
import { notificationRouter } from "../services/notificationRouter";
import { pushNotificationService } from "../services/push";
import { capturePersistentFailure } from "./dlq";
import { queryRead, queryWrite } from "../config/database";
import subscriptionModel from "../models/subscription";
import logger from "../utils/logger";

const transactionModel = new TransactionModel();
const mobileMoneyService = new MobileMoneyService();
const stellarService = new StellarService();
const userModel = new UserModel();
const emailService = new EmailService();
const pushService = pushNotificationService;
const webhookService = new WebhookService();

const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.TRANSACTION_WORKER_CONCURRENCY || "5", 10),
);

export async function handleSubscriptionFailure(
  subscriptionId: string,
  transactionId: string | null,
  error: unknown,
  log = logger,
) {
  try {
    const sub = await subscriptionModel.getById(subscriptionId);
    const attemptRow = await subscriptionModel.incrementRetry(subscriptionId);
    const attemptNumber = attemptRow ? attemptRow.retry_count : 1;
    await subscriptionModel.recordAttempt(subscriptionId, transactionId, attemptNumber, "failed", getErrorMessage(error));

    if (attemptRow && attemptRow.retry_count >= attemptRow.max_retries) {
      await subscriptionModel.pause(subscriptionId);
      log.warn({ subscriptionId }, "Subscription paused after max retries");
      try {
        const merchant = await userModel.findById(sub.merchant_id);
        await notificationRouter.routeSystemNotification(
          "high",
          "subscription",
          "Subscription Paused",
          `Subscription ${subscriptionId} paused after ${attemptRow.retry_count} failed attempts`,
          { subscriptionId, merchantId: sub.merchant_id },
        );
        if (merchant?.email) {
          await emailService.sendEmail({
            to: merchant.email,
            templateId: process.env.SENDGRID_GENERAL_TEMPLATE_ID || "",
            dynamicTemplateData: {
              title: "Subscription Paused",
              message: `Your subscription (${subscriptionId}) has been paused after ${attemptRow.retry_count} failed attempts. Please review and resume if required.`,
            },
          });
        }
      } catch (notifyErr) {
        log.error({ notifyErr }, "Failed to notify merchant about subscription pause");
      }
    } else if (attemptRow) {
      const base = attemptRow.retry_backoff_seconds || 600;
      const delay = base * Math.pow(2, Math.max(0, attemptRow.retry_count - 1));
      await queryWrite(`UPDATE subscriptions SET next_run_at = NOW() + ($1 || ' seconds')::interval, updated_at = NOW() WHERE id = $2`, [delay, subscriptionId]);
      log.info({ subscriptionId, delay }, "Scheduled subscription retry");
    }
  } catch (ex) {
    log.error({ ex }, "handleSubscriptionFailure failed");
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function getProviderFailureMessage(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "Provider request failed";
  }

  const error = (result as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Provider request failed";
}

async function sendTransactionEmail(transactionId: string): Promise<void> {
  const transaction = await transactionModel.findById(transactionId);
  if (!transaction?.userId) {
    return;
  }

  const user = await userModel.findById(transaction.userId);
  if (user?.email) {
    await emailService.sendTransactionReceipt(
      user.email,
      transaction,
      user.preferredLanguage,
      user.displayName,
    );
  }
}

async function sendFailureEmail(
  transactionId: string,
  reason: string,
): Promise<void> {
  const transaction = await transactionModel.findById(transactionId);
  if (!transaction?.userId) {
    return;
  }

  const user = await userModel.findById(transaction.userId);
  if (user?.email) {
    await emailService.sendTransactionFailure(
      user.email,
      transaction,
      reason,
      user.preferredLanguage,
      user.displayName,
    );
  }
}

async function sendTransactionPush(
  transactionId: string,
  status: "completed" | "failed",
  error?: string,
): Promise<void> {
  const transaction = await transactionModel.findById(transactionId);
  if (!transaction?.userId) {
    return;
  }

  try {
    if (status === "completed") {
      await pushService.sendTransactionComplete(transaction.userId, {
        transactionId: transaction.id,
        referenceNumber: transaction.referenceNumber,
        type: transaction.type as "deposit" | "withdraw",
        amount: String(transaction.amount),
        status: "completed",
        error,
      });
    } else {
      await pushService.sendTransactionFailed(transaction.userId, {
        transactionId: transaction.id,
        referenceNumber: transaction.referenceNumber,
        type: transaction.type as "deposit" | "withdraw",
        amount: String(transaction.amount),
        status: "failed",
        error,
      });
    }
  } catch (pushError) {
    console.error(`[${transactionId}] Push notification failed:`, pushError);
  }
}

async function updateProgress(transactionId: string, progress: number) {
  try {
    await (transactionModel as any).patchMetadata(transactionId, { progress });
  } catch (err) {
    console.warn(`[${transactionId}] Failed to update progress metadata:`, err);
  }
}

/** Resolves a user's full name from KYC data for sanction screening. */
async function resolveKycName(userId: string): Promise<string | null> {
  try {
    const result = await queryRead(
      `SELECT applicant_data->>'first_name' AS "firstName",
              applicant_data->>'last_name'  AS "lastName"
       FROM kyc_applicants WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!result.rows.length) return null;
    const { firstName, lastName } = result.rows[0];
    return `${firstName ?? ""} ${lastName ?? ""}`.trim() || null;
  } catch {
    return null;
  }
}

async function processTransaction(
  data: TransactionJobData,
): Promise<TransactionJobResult> {
  const {
    transactionId,
    type,
    amount,
    phoneNumber,
    provider,
    stellarAddress,
    requestId,
    _traceId,
  } = data;

  const logFields: Record<string, string> = { transactionId };
  if (requestId) logFields.requestId = requestId;
  if (_traceId) logFields.traceId = _traceId;
  const log = logger.child(logFields);
  log.info({ type, provider }, `[RabbitMQ] Processing transaction`);

  const maxAttempts = Math.max(
    1,
    parseInt(process.env.MAX_RETRY_ATTEMPTS || "3", 10),
  );
  const baseDelayMs = Math.max(
    0,
    parseInt(process.env.RETRY_DELAY_MS || "1000", 10),
  );

  const retryConfig = {
    maxAttempts,
    baseDelayMs,
    provider,
    onRetry: async ({
      attempt,
      error,
    }: {
      attempt: number;
      error: unknown;
    }) => {
      await transactionModel.incrementRetryCount(transactionId);
      log.warn(
        { attempt, error: error instanceof Error ? error.message : error },
        "Transient failure, will retry",
      );
    },
  };

  // Resolve sender name for sanction screening (best-effort; falls back to phone number)
  const txRow = await transactionModel.findById(transactionId);
  const senderName =
    (txRow?.userId ? await resolveKycName(txRow.userId) : null) ?? phoneNumber;
  // Receiver is the mobile money account holder identified by their phone number
  const receiverName = phoneNumber;

  const sendTxnSms = async (
    kind: "transaction_completed" | "transaction_failed",
    errorMessage?: string,
  ) => {
    try {
      const txRow = await transactionModel.findById(transactionId);
      if (!txRow?.userId) return;

      const user = await userModel.findById(txRow.userId);
      if (user?.smsOptOut) {
        console.log(
          `[${transactionId}] SMS notifications skipped (User Opted Out)`,
        );
        return;
      }

      const ref = txRow?.referenceNumber ?? transactionId;
      await smsService.notifyTransactionEvent(phoneNumber, {
        referenceNumber: ref,
        type,
        amount: String(amount),
        provider,
        kind,
        errorMessage,
      });
    } catch (smsErr) {
      log.error({ smsErr }, "SMS notification error");
    }
  };

        const stellarResult = await withRetry(
          () => {
            // Use high-throughput pool service when available; falls back to single-account mode
            const issuerSecret = process.env.STELLAR_ISSUER_SECRET?.trim();
            if (highThroughputService.isServiceInitialized() && issuerSecret) {
              const issuerKp = require("stellar-sdk").Keypair.fromSecret(issuerSecret);
              return highThroughputService.submitPayment({
                sourceAccount: issuerKp.publicKey(),
                sourceSecret: issuerSecret,
                destination: stellarAddress,
                asset: "native",
                amount: String(amount),
              }).then(r => ({ hash: r.hash, submittedAt: new Date() }));
            }
            return stellarService.sendPayment(stellarAddress, amount, senderName, receiverName);
          },
          retryConfig,
        );

  // Store Stellar transaction details in metadata
  if (stellarResult.hash) {
    const currentMetadata =
      (await transactionModel.findById(transactionId))?.metadata || {};
    const updatedMetadata = {
      ...currentMetadata,
      stellar: {
        transactionHash: stellarResult.hash,
        submittedAt: stellarResult.submittedAt?.toISOString(),
        feeBumps: [],
      },
    };
    await transactionModel.updateMetadata(transactionId, updatedMetadata);
  }

  await updateProgress(transactionId, 90);
  try {
    await updateProgress(transactionId, 10);

    if (type === "deposit") {
      await updateProgress(transactionId, 20);

      const mobileMoneyResult = await withRetry(async () => {
        const result = await mobileMoneyService.initiatePayment(
          provider,
          phoneNumber,
          amount,
          requestId,
        );
        if (!result.success) {
          throw new Error(getProviderFailureMessage(result));
        }
        return result;
      }, retryConfig);

      // Issue #515: Log provider response time in transaction metadata
      if (mobileMoneyResult.providerResponseTimeMs !== undefined) {
        await (transactionModel as any)
          .patchMetadata(transactionId, {
            providerResponseTimeTimeMs:
              mobileMoneyResult.providerResponseTimeMs,
            providerRespondedAt: new Date().toISOString(),
          })
          .catch((err: any) =>
            log.warn({ err }, "Failed to log provider response time"),
          );
      }

      await updateProgress(transactionId, 50);

      if (!mobileMoneyResult.success) {
        throw new Error(getProviderFailureMessage(mobileMoneyResult));
      }
      await updateProgress(transactionId, 70);

      await withRetry(
        () => {
          // Use high-throughput pool service when available; falls back to single-account mode
          const issuerSecret = process.env.STELLAR_ISSUER_SECRET?.trim();
          if (highThroughputService.isServiceInitialized() && issuerSecret) {
            const issuerKp = require("stellar-sdk").Keypair.fromSecret(issuerSecret);
            return highThroughputService.submitPayment({
              sourceAccount: issuerKp.publicKey(),
              sourceSecret: issuerSecret,
              destination: stellarAddress,
              asset: "native",
              amount: String(amount),
            });
          }
          return stellarService.sendPayment(stellarAddress, amount, senderName, receiverName);
        },
        retryConfig,
      );

      if (stellarResult.hash) {
        const currentMetadata =
          (await transactionModel.findById(transactionId))?.metadata || {};
        const updatedMetadata = {
          ...currentMetadata,
          stellar: {
            transactionHash: stellarResult.hash,
            submittedAt: stellarResult.submittedAt?.toISOString(),
            feeBumps: [],
          },
        };
        await transactionModel.updateMetadata(transactionId, updatedMetadata);
      }

      await updateProgress(transactionId, 90);

      await transactionModel.updateStatus(
        transactionId,
        TransactionStatus.Completed,
      );
      await notifyTransactionWebhook(transactionId, "transaction.completed", {
        transactionModel: transactionModel as any,
        webhookService,
      });

      const transaction = await transactionModel.findById(transactionId);
      if (transaction) {
        await notificationRouter.routeTransactionNotification(
          transaction,
          "completed",
        );
      }

      // Fan-out event
      await rabbitMQManager.publish(
        EXCHANGES.TRANSACTIONS,
        ROUTING_KEYS.TRANSACTION_COMPLETED,
        {
          transactionId,
          status: "completed",
        },
      );

      await updateProgress(transactionId, 100);
      log.info("Deposit completed successfully");

      return { success: true, transactionId };
    } else {
      await updateProgress(transactionId, 20);

      const mobileMoneyResult = await withRetry(async () => {
        const result = await mobileMoneyService.sendPayout(
          provider,
          phoneNumber,
          amount,
          requestId,
        );
        if (!result.success) {
          throw new Error(getProviderFailureMessage(result));
        }
        return result;
      }, retryConfig);

      // Issue #515: Log provider response time in transaction metadata
      if (mobileMoneyResult.providerResponseTimeMs !== undefined) {
        await (transactionModel as any)
          .patchMetadata(transactionId, {
            providerResponseTimeMs: mobileMoneyResult.providerResponseTimeMs,
            providerRespondedAt: new Date().toISOString(),
          })
          .catch((err: any) =>
            log.warn({ err }, "Failed to log provider response time"),
          );
      }

      await updateProgress(transactionId, 50);

      if (!mobileMoneyResult.success) {
        throw new Error(getProviderFailureMessage(mobileMoneyResult));
      }
      await updateProgress(transactionId, 90);

      await transactionModel.updateStatus(
        transactionId,
        TransactionStatus.Completed,
      );
      await notifyTransactionWebhook(transactionId, "transaction.completed", {
        transactionModel: transactionModel as any,
        webhookService,
      });

      const transaction = await transactionModel.findById(transactionId);
      if (transaction) {
        await notificationRouter.routeTransactionNotification(
          transaction,
          "completed",
        );
      }

      await rabbitMQManager.publish(
        EXCHANGES.TRANSACTIONS,
        ROUTING_KEYS.TRANSACTION_COMPLETED,
        {
          transactionId,
          status: "completed",
        },
      );

      await updateProgress(transactionId, 100);
      log.info("Withdraw completed successfully");

      return { success: true, transactionId };
    }
  } catch (error) {
    log.error({ error }, "Transaction failed");
    await transactionModel.updateStatus(
      transactionId,
      TransactionStatus.Failed,
    );
    await notifyTransactionWebhook(transactionId, "transaction.failed", {
      transactionModel: transactionModel as any,
      webhookService,
    });

    const transaction = await transactionModel.findById(transactionId);
    if (transaction) {
      await notificationRouter.routeTransactionNotification(
        transaction,
        "failed",
        getErrorMessage(error),
      );
    }

    // Fan-out event
    await rabbitMQManager.publish(
      EXCHANGES.TRANSACTIONS,
      ROUTING_KEYS.TRANSACTION_FAILED,
      {
        transactionId,
        status: "failed",
        error: getErrorMessage(error),
      },
    );

    // If this transaction was created by a subscription, record attempt and schedule retry if configured
    try {
      const tx = await transactionModel.findById(transactionId);
      const subscriptionId = (tx?.metadata && (tx.metadata.subscription_id || tx.metadata.subscriptionId)) || null;
      if (subscriptionId) {
        await handleSubscriptionFailure(subscriptionId, transactionId, error, log);
      }
    } catch (subErr) {
      log.error({ subErr }, "Failed to record subscription retry info");
    }

    // TODO: commented out because I couldn't find the job variable so to clear `rebase/merge` error
    // if (job) {
    //   capturePersistentFailure(job).catch(err => console.error('[DLQ] Error capturing failure:', err));
    // }
  }
  // );

  // throw error;
}
// }

// Start consuming
const consumerLabel = NATS_QUEUE_ENABLED ? "NATS JetStream" : "RabbitMQ";

if (NATS_QUEUE_ENABLED) {
  natsManager
    .consume<TransactionJobData>(
      NATS_SUBJECT,
      NATS_DURABLE_CONSUMER,
      NATS_CONSUMER_GROUP,
      async (data) => {
        await processTransaction(data);
      },
      CONCURRENCY,
    )
    .catch((err) => logger.error({ err }, "NATS JetStream Consumer error"));
} else {
  rabbitMQManager.consume<TransactionJobData>(
    QUEUES.TRANSACTION_PROCESSING,
    async (data) => {
      await processTransaction(data);
    },
    CONCURRENCY,
  ).catch((err) => logger.error({ err }, "RabbitMQ Consumer error"));
}

export const transactionWorker = {
  close: async () => {
    if (NATS_QUEUE_ENABLED) {
      await natsManager.close();
    }
  },
};

export async function closeWorker() {
  await transactionWorker.close();
}
