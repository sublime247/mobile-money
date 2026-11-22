// Tracer must be imported before any other module so HTTP/DB/Redis spans are
// instrumented in this worker process as well (the standalone worker entry
// point is `node dist/src/queue/worker.js`).
import "../tracer";

import { Worker } from "bullmq";
import {
  TransactionJobData,
  TransactionJobResult,
  TRANSACTION_QUEUE_NAME,
} from "./transactionQueue";
import { withJobTrace } from "./jobTracing";
import { rabbitMQManager, EXCHANGES, ROUTING_KEYS } from "./rabbitmq";
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
import { smsService } from "../services/sms";
import { withRetry } from "../services/retry";
import { notifyTransactionWebhook, WebhookService } from "../services/webhook";
import { notificationRouter } from "../services/notificationRouter";
import { pushNotificationService } from "../services/push";
import { capturePersistentFailure } from "./dlq";
import { isBlacklisted } from "../middleware/ipBlacklist";
import { queryRead, queryWrite } from "../config/database";
import subscriptionModel from "../models/subscription";
import logger from "../utils/logger";
import { amlScreeningService } from "../services/amlScreening";

import { queueOptions, getWorkerConcurrency } from "./config";
import { providerQueueControl } from "./providerQueueControl";
import { WorkerAutoscaler, isAutoscalerEnabled } from "./workerAutoscaler";
import { transactionQueue } from "./transactionQueue";
import {
  createProviderWorker,
  isProviderRateLimitedQueuesEnabled,
} from "./providerRateLimitedQueues";

const transactionModel = new TransactionModel();
const mobileMoneyService = new MobileMoneyService();
const stellarService = new StellarService();
const userModel = new UserModel();
const emailService = new EmailService();
const pushService = pushNotificationService;
const webhookService = new WebhookService();

const CONCURRENCY = getWorkerConcurrency();

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
    await subscriptionModel.recordAttempt(
      subscriptionId,
      transactionId,
      attemptNumber,
      "failed",
      getErrorMessage(error),
    );

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
        log.error(
          { notifyErr },
          "Failed to notify merchant about subscription pause",
        );
      }
    } else if (attemptRow) {
      const base = attemptRow.retry_backoff_seconds || 600;
      const delay = base * Math.pow(2, Math.max(0, attemptRow.retry_count - 1));
      await queryWrite(
        `UPDATE subscriptions SET next_run_at = NOW() + ($1 || ' seconds')::interval, updated_at = NOW() WHERE id = $2`,
        [delay, subscriptionId],
      );
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
    logger.error(`[${transactionId}] Push notification failed:`, pushError);
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

/**
 * Screens the cash-out recipient against OFAC/UN/EU sanctions and PEP lists
 * before any disbursement. A match moves the transaction to `review` (frozen
 * for high-confidence sanctions hits) and returns true so the caller stops.
 * The customer is deliberately not notified (tipping-off).
 */
async function holdWithdrawalIfSanctioned(
  transactionId: string,
  userId?: string | null,
): Promise<boolean> {
  const recipientName = userId ? await resolveKycName(userId) : null;
  if (!recipientName) {
    logger.warn(
      { transactionId },
      "[Screening] No KYC name available; skipping sanctions/PEP screening",
    );
    return false;
  }

  const result = await amlScreeningService.screenRecipient({
    transactionId,
    userId: userId ?? undefined,
    recipientName,
  });

  if (result.pepMatches.length > 0) {
    await transactionModel.addTags(transactionId, ["pep-flagged"]);
  }
  if (result.decision === "clear" || !result.topSanctionsMatch) return false;

  const { topSanctionsMatch: top } = result;
  const frozen = result.decision === "block";
  await transactionModel.updateStatus(transactionId, TransactionStatus.Review);
  await Promise.all([
    transactionModel.addTags(transactionId, [
      "compliance-hold",
      frozen ? "sanctions-frozen" : "sanctions-review",
    ]),
    transactionModel.patchMetadata(transactionId, {
      sanctionsScreening: {
        frozen,
        list: top.source,
        listReference: top.externalId ?? null,
        score: top.score,
        auditRecordIds: result.auditRecordIds,
        screenedAt: new Date().toISOString(),
      },
    }),
  ]);
  return true;
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
    clientIp,
  } = data;

  // ── IP Blacklist check ──────────────────────────────────────────────────────
  // Reject jobs whose originating IP is blacklisted before any provider I/O.
  if (clientIp) {
    const blocked = await isBlacklisted(clientIp);
    if (blocked) {
      console.warn(
        `[ipBlacklist] Worker rejected job ${transactionId} — originating IP is blacklisted: ${clientIp}`,
      );
      await transactionModel.updateStatus(
        transactionId,
        TransactionStatus.Failed,
      );
      await notifyTransactionWebhook(transactionId, "transaction.failed", {
        transactionModel,
        webhookService,
      });
      await rabbitMQManager.publish(
        EXCHANGES.TRANSACTIONS,
        ROUTING_KEYS.TRANSACTION_FAILED,
        {
          transactionId,
          status: "failed",
          error: "Request originated from a blacklisted IP address",
        },
      );
      return {
        success: false,
        transactionId,
        error: "Request originated from a blacklisted IP address",
      };
    }
  }
  // ── Race condition guard / Atomic transaction claim ────────────────────────
  // Atomically claim the transaction for processing so duplicate/parallel worker instances
  // do not execute payments or side-effects twice for the same transaction.
  if (typeof transactionModel.claimForProcessing === "function") {
    const claimed = await transactionModel.claimForProcessing(transactionId);
    if (!claimed) {
      const existing = await transactionModel.findById(transactionId);
      if (existing && existing.status !== TransactionStatus.Pending) {
        logger.warn(
          { transactionId, status: existing.status },
          `[Worker] Transaction already claimed/processed (${existing.status}). Skipping duplicate processing.`,
        );
        return {
          success: existing.status === TransactionStatus.Completed,
          transactionId,
        };
      }
    }
  }
  // ───────────────────────────────────────────────────────────────────────────

  console.log(`[RabbitMQ] Processing ${type} transaction: ${transactionId}`);
  const { requestId, _traceId } = data;

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

  if (
    type === "withdraw" &&
    (await holdWithdrawalIfSanctioned(transactionId, txRow?.userId))
  ) {
    return { success: false, transactionId };
  }

  const senderName =
    (txRow?.userId ? await resolveKycName(txRow.userId) : null) ?? phoneNumber;
  // Receiver is the mobile money account holder identified by their phone number
  const receiverName = phoneNumber;

  const stellarResult = await withRetry(() => {
    // Use high-throughput pool service when available; falls back to single-account mode
    const issuerSecret = process.env.STELLAR_ISSUER_SECRET?.trim();
    if (highThroughputService.isServiceInitialized() && issuerSecret) {
      const issuerKp = require("@stellar/stellar-sdk").Keypair.fromSecret(issuerSecret);
      return highThroughputService
        .submitPayment({
          sourceAccount: issuerKp.publicKey(),
          sourceSecret: issuerSecret,
          destination: stellarAddress,
          asset: "native",
          amount: String(amount),
        })
        .then((r) => ({ hash: r.hash, submittedAt: new Date() }));
    }
    return stellarService.sendPayment(
      stellarAddress,
      amount,
      senderName,
      receiverName,
    );
  }, retryConfig);

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

  try {
    await updateProgress(transactionId, 10);

    const currentTx = await transactionModel.findById(transactionId);
    const metadata = currentTx?.metadata || {};

    if (type === "deposit") {
      await updateProgress(transactionId, 20);

      // Check if mobile money payment was already initiated or succeeded
      let mobileMoneyResult = (metadata as any)?.mobileMoney;
      if (!mobileMoneyResult?.success) {
        mobileMoneyResult = await withRetry(async () => {
          const result = await mobileMoneyService.initiatePayment(
            provider,
            phoneNumber,
            amount,
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
              mobileMoney: mobileMoneyResult,
              providerResponseTimeTimeMs:
                mobileMoneyResult.providerResponseTimeMs,
              providerRespondedAt: new Date().toISOString(),
            })
            .catch((err: any) =>
              log.warn({ err }, "Failed to log provider response time"),
            );
        } else {
          await (transactionModel as any)
            .patchMetadata(transactionId, {
              mobileMoney: mobileMoneyResult,
            })
            .catch((err: any) =>
              log.warn({ err }, "Failed to patch mobileMoney metadata"),
            );
        }
      }

      await updateProgress(transactionId, 50);

      if (!mobileMoneyResult?.success) {
        throw new Error(getProviderFailureMessage(mobileMoneyResult));
      }
      await updateProgress(transactionId, 70);

      // Idempotency: Check if Stellar payment was already submitted on a previous attempt/retry
      let stellarResult = (metadata as any)?.stellar;
      if (!stellarResult?.transactionHash) {
        const stellarSubmission = await withRetry(() => {
          // Use high-throughput pool service when available; falls back to single-account mode
          const issuerSecret = process.env.STELLAR_ISSUER_SECRET?.trim();
          if (highThroughputService.isServiceInitialized() && issuerSecret) {
            const issuerKp =
              require("@stellar/stellar-sdk").Keypair.fromSecret(issuerSecret);
            return highThroughputService
              .submitPayment({
                sourceAccount: issuerKp.publicKey(),
                sourceSecret: issuerSecret,
                destination: stellarAddress,
                asset: "native",
                amount: String(amount),
              })
              .then((r) => ({ hash: r.hash, submittedAt: new Date() }));
          }
          return stellarService.sendPayment(
            stellarAddress,
            amount,
            senderName,
            receiverName,
          );
        }, retryConfig);

        stellarResult = {
          transactionHash: stellarSubmission.hash,
          submittedAt: (
            stellarSubmission.submittedAt || new Date()
          ).toISOString(),
          feeBumps: [],
        };

        const updatedTx = await transactionModel.findById(transactionId);
        const currentMeta = updatedTx?.metadata || {};
        await transactionModel.updateMetadata(transactionId, {
          ...currentMeta,
          stellar: stellarResult,
        });
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
    const transaction = await transactionModel.findById(transactionId);
    if (transaction) {
      await notificationRouter.routeTransactionNotification(
        transaction,
        "failed",
        getErrorMessage(error),
      );
    }

    await notifyTransactionWebhook(transactionId, "transaction.failed", {
      transactionModel: transactionModel as any,
      webhookService,
    });

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
      const subscriptionId = (tx?.metadata &&
        ((tx.metadata.subscription_id as string | undefined) ||
          (tx.metadata.subscriptionId as string | undefined))) as
        string | null | undefined;
      if (subscriptionId) {
        await handleSubscriptionFailure(
          subscriptionId,
          transactionId,
          error,
          log,
        );
      }
    } catch (subErr) {
      log.error({ subErr }, "Failed to record subscription retry info");
    }

    // TODO: capture the BullMQ job so permanently-failed jobs can be routed
    // to the DLQ from the worker 'failed' event listener.

    // BullMQ completes the job with a failure result; the broker-level
    // `attempts` is left at 1 because retrying the whole job from scratch
    // could double-send a payment (in-process retries handle transient
    // failures via `withRetry`).
    return {
      success: false,
      transactionId,
      error: getErrorMessage(error),
    };
  }
}

// Start consuming: NATS JetStream when enabled, otherwise a BullMQ Worker.
if (NATS_QUEUE_ENABLED) {
  natsManager
    .consume<TransactionJobData>(
      NATS_SUBJECT,
      NATS_DURABLE_CONSUMER,
      NATS_CONSUMER_GROUP,
      async (data) => {
        await withJobTrace(
          "queue.transaction.process",
          data,
          () => processTransaction(data),
          {
            "messaging.system": "nats",
            "messaging.destination.name": NATS_SUBJECT,
            "transaction.id": data.transactionId,
            "transaction.type": data.type,
          },
        );
      },
      CONCURRENCY,
    )
    .catch((err) => logger.error({ err }, "NATS JetStream Consumer error"));
}

/**
 * Shared BullMQ job processor, used by both the default single-queue worker
 * below and, when `PROVIDER_RATE_LIMITED_QUEUES_ENABLED=true` (#2277), by
 * each provider's own rate-limited worker - so per-provider rate limiting
 * reuses the exact same transaction-processing logic rather than
 * duplicating it per provider.
 */
async function handleTransactionJob(
  job: Parameters<Parameters<typeof createProviderWorker>[1]>[0],
  queueName: string,
) {
  // Provider paused for maintenance (#2282): divert the job to the
  // provider's hold queue before any provider I/O. It is re-queued
  // here automatically when the provider is resumed.
  if (await providerQueueControl.divertIfPaused(job)) {
    return {
      success: false,
      transactionId: job.data.transactionId,
      error: "provider_paused",
    };
  }

  return withJobTrace(
    "queue.transaction.process",
    job.data,
    () => processTransaction(job.data),
    {
      "messaging.system": "bullmq",
      "messaging.destination.name": queueName,
      "messaging.message.id": job.id ?? "",
      "job.name": job.name,
      "job.attempt": job.attemptsMade + 1,
      "transaction.id": job.data.transactionId,
      "transaction.type": job.data.type,
    },
  );
}

export const transactionWorker:
  | Worker<TransactionJobData, TransactionJobResult>
  | {
      close: () => Promise<void>;
    } = NATS_QUEUE_ENABLED
  ? {
      close: async () => {
        await natsManager.close();
      },
    }
  : new Worker<TransactionJobData, TransactionJobResult>(
      TRANSACTION_QUEUE_NAME,
      (job) => handleTransactionJob(job, TRANSACTION_QUEUE_NAME),
      { ...queueOptions, concurrency: CONCURRENCY },
    );

// Scale worker concurrency with queue depth (BullMQ worker only; the NATS
// consumer manages its own concurrency).
let workerAutoscaler: WorkerAutoscaler | null = null;
if (
  transactionWorker instanceof Worker &&
  isAutoscalerEnabled() &&
  process.env.NODE_ENV !== "test"
) {
  workerAutoscaler = new WorkerAutoscaler(transactionQueue, transactionWorker);
  workerAutoscaler.start();
}
/**
 * Per-provider rate-limited workers (#2277). Each provider gets its own
 * BullMQ Worker consuming its own queue (src/queue/providerRateLimitedQueues.ts),
 * configured with that provider's `limiter` (max jobs/sec), so e.g. MTN and
 * Orange are throttled independently and a burst is delayed - not
 * failed - once the configured rate is hit. Only created when
 * `PROVIDER_RATE_LIMITED_QUEUES_ENABLED=true`; `addTransactionJob` only
 * routes jobs here when the same flag is set, so the two stay in sync.
 */
const providerWorkers: Array<Worker<TransactionJobData, TransactionJobResult>> =
  !NATS_QUEUE_ENABLED && isProviderRateLimitedQueuesEnabled()
    ? ["mtn", "orange", "airtel", "vodafone"].map((provider) =>
        createProviderWorker(provider, (job) =>
          handleTransactionJob(job, `transaction-provider-${provider}`),
        ),
      )
    : [];

export async function closeWorker(): Promise<void> {
  workerAutoscaler?.stop();
  await transactionWorker.close();
  await Promise.all(providerWorkers.map((w) => w.close()));
  if (NATS_QUEUE_ENABLED) {
    await natsManager.close();
  }
}
