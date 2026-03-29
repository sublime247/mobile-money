import { Worker, Job, JobProgress } from "bullmq";
import {
  TransactionJobData,
  TransactionJobResult,
  TRANSACTION_QUEUE_NAME,
} from "./transactionQueue";
import { queueOptions } from "./config";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { StellarService } from "../services/stellar/stellarService";
import { EmailService } from "../services/email";
import { UserModel } from "../models/users";
import { withRetry } from "../services/retry";
import { WhatsappService } from "../services/whatsapp";
import { notifyTransactionWebhook, WebhookService } from "../services/webhook";
import { pushNotificationService } from "../services/push";
import { capturePersistentFailure } from "./dlq";
const transactionModel = new TransactionModel();
const mobileMoneyService = new MobileMoneyService();
const stellarService = new StellarService();
const emailService = new EmailService();
const userModel = new UserModel();
const whatsappService = new WhatsappService();
const webhookService = new WebhookService();
const pushService = pushNotificationService;

const workerOptions = {
  ...queueOptions,
  concurrency: 5,
  limiter: {
    max: 10,
    duration: 1000,
  },
};

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
    // Don't throw - push failures shouldn't block the transaction flow
  }
}

export const transactionWorker = new Worker<
  TransactionJobData,
  TransactionJobResult
>(
  TRANSACTION_QUEUE_NAME,
  async (job: Job<TransactionJobData, TransactionJobResult>) => {
    const {
      transactionId,
      type,
      amount,
      phoneNumber,
      provider,
      stellarAddress,
    } = job.data;

    console.log(`[${job.id}] Processing ${type} transaction: ${transactionId}`);

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
      onRetry: async ({
        attempt,
        error,
      }: {
        attempt: number;
        error: unknown;
      }) => {
        await transactionModel.incrementRetryCount(transactionId);
        console.warn(
          `[${job.id}] transient failure (attempt ${attempt}), will retry:`,
          error instanceof Error ? error.message : error,
        );
      },
    };

    const sendTxnSms = async (
      kind: "transaction_completed" | "transaction_failed",
      errorMessage?: string,
    ) => {
      try {
        const txRow = await transactionModel.findById(transactionId);
        const ref = txRow?.referenceNumber ?? transactionId;
        let locale = "en";

        if (txRow?.userId) {
          const user = await userModel.findById(txRow.userId);
          locale = user?.preferredLanguage || "en";
        }

        await whatsappService.notifyTransactionEvent(phoneNumber, {
          referenceNumber: ref,
          type,
          amount: String(amount),
          provider,
          kind,
          errorMessage,
          locale,
        });
      } catch (smsErr) {
        console.error(`[${job.id}] Notification error`, smsErr);
      }
    };

    try {
      await job.updateProgress(10);

      if (type === "deposit") {
        await job.updateProgress(20);

        const mobileMoneyResult = await withRetry(async () => {
          const mobileMoneyResult = await mobileMoneyService.initiatePayment(
            provider,
            phoneNumber,
            amount,
          );
          if (!mobileMoneyResult.success) {
            throw new Error(getProviderFailureMessage(mobileMoneyResult));
          }
          return mobileMoneyResult;
        }, retryConfig);

        await job.updateProgress(50);

        if (!mobileMoneyResult.success) {
          throw new Error(getProviderFailureMessage(mobileMoneyResult));
        }
        await job.updateProgress(70);

        await withRetry(
          () => stellarService.sendPayment(stellarAddress, amount),
          retryConfig,
        );

        await job.updateProgress(90);

        await transactionModel.updateStatus(
          transactionId,
          TransactionStatus.Completed,
        );
        await notifyTransactionWebhook(transactionId, "transaction.completed", {
          transactionModel,
          webhookService,
        });
        await sendTransactionEmail(transactionId);
        await sendTransactionPush(transactionId, "completed");

        await sendTxnSms("transaction_completed");

        await job.updateProgress(100);

        console.log(
          `[${job.id}] Deposit completed successfully: ${transactionId}`,
        );

        return {
          success: true,
          transactionId,
        };
      } else {
        await job.updateProgress(20);

        const mobileMoneyResult = await withRetry(async () => {
          const mobileMoneyResult = await mobileMoneyService.sendPayout(
            provider,
            phoneNumber,
            amount,
          );
          if (!mobileMoneyResult.success) {
            throw new Error(getProviderFailureMessage(mobileMoneyResult));
          }
          return mobileMoneyResult;
        }, retryConfig);

        await job.updateProgress(50);

        if (!mobileMoneyResult.success) {
          throw new Error(getProviderFailureMessage(mobileMoneyResult));
        }
        await job.updateProgress(90);

        await transactionModel.updateStatus(
          transactionId,
          TransactionStatus.Completed,
        );
        await notifyTransactionWebhook(transactionId, "transaction.completed", {
          transactionModel,
          webhookService,
        });
        await sendTransactionEmail(transactionId);
        await sendTransactionPush(transactionId, "completed");

        await sendTxnSms("transaction_completed");

        await job.updateProgress(100);

        console.log(
          `[${job.id}] Withdraw completed successfully: ${transactionId}`,
        );

        return {
          success: true,
          transactionId,
        };
      }
    } catch (error) {
      console.error(`[${job.id}] Transaction failed:`, error);
      await transactionModel.updateStatus(
        transactionId,
        TransactionStatus.Failed,
      );
      await notifyTransactionWebhook(transactionId, "transaction.failed", {
        transactionModel,
        webhookService,
      });
      await sendFailureEmail(transactionId, getErrorMessage(error));
      await sendTransactionPush(transactionId, "failed", getErrorMessage(error));
      throw error;
    }
  },
  workerOptions,
);

transactionWorker.on(
  "completed",
  (job: Job<TransactionJobData, TransactionJobResult>) => {
    console.log(`[${job.id}] Job completed successfully`);
  },
);

transactionWorker.on(
  "failed",
  (
    job: Job<TransactionJobData, TransactionJobResult> | undefined,
    error: Error,
  ) => {
    console.error(
      `[${job?.id}] Job failed after ${job?.attemptsMade} attempts:`,
      error.message,
    );

    if (job) {
      capturePersistentFailure(job).catch(err => console.error('[DLQ] Error capturing failure:', err));
    }
  },
);

transactionWorker.on(
  "progress",
  (
    job: Job<TransactionJobData, TransactionJobResult>,
    progress: JobProgress,
  ) => {
    console.log(`[${job.id}] Job progress: ${progress}%`);
  },
);

export async function closeWorker() {
  await transactionWorker.close();
}
