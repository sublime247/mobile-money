import logger from "../utils/logger";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService, BatchPayoutItem, BatchPayoutResult } from "../services/mobilemoney/mobileMoneyService";
import { rabbitMQManager, EXCHANGES, ROUTING_KEYS } from "./rabbitmq";
import { EmailService } from "../services/email";
import { UserModel } from "../models/users";
import { SmsService } from "../services/sms";
import { notifyTransactionWebhook, WebhookService } from "../services/webhook";
import { pushNotificationService } from "../services/push";
import {
  batchPayoutTotal,
  batchPayoutItemsTotal,
  batchPayoutDurationSeconds,
  batchPayoutSize,
} from "../utils/metrics";

const transactionModel = new TransactionModel();
const mobileMoneyService = new MobileMoneyService();
const emailService = new EmailService();
const userModel = new UserModel();
const smsService = new SmsService();
const webhookService = new WebhookService();
const pushService = pushNotificationService;

const BATCH_SIZE = 100;
const BATCH_INTERVAL_MS = parseInt(process.env.BATCH_PAYOUT_INTERVAL_MS || "5000", 10);
const SUPPORTED_PROVIDERS = ["mtn"];

interface PendingPayout {
  transactionId: string;
  phoneNumber: string;
  amount: string;
  provider: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function sendTransactionEmail(transactionId: string): Promise<void> {
  const transaction = await transactionModel.findById(transactionId);
  if (!transaction?.userId) return;

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

async function sendFailureEmail(transactionId: string, reason: string): Promise<void> {
  const transaction = await transactionModel.findById(transactionId);
  if (!transaction?.userId) return;

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
  if (!transaction?.userId) return;

  try {
    if (status === "completed") {
      await pushService.sendTransactionComplete(transaction.userId, {
        transactionId: transaction.id,
        referenceNumber: transaction.referenceNumber,
        type: "withdraw",
        amount: String(transaction.amount),
        status: "completed",
        error,
      });
    } else {
      await pushService.sendTransactionFailed(transaction.userId, {
        transactionId: transaction.id,
        referenceNumber: transaction.referenceNumber,
        type: "withdraw",
        amount: String(transaction.amount),
        status: "failed",
        error,
      });
    }
  } catch (pushError) {
    logger.error(`[${transactionId}] Push notification failed:`, pushError);
  }
}

async function sendTxnSms(
  transactionId: string,
  phoneNumber: string,
  amount: string,
  provider: string,
  kind: "transaction_completed" | "transaction_failed",
  errorMessage?: string,
): Promise<void> {
  try {
    const txRow = await transactionModel.findById(transactionId);
    if (!txRow?.userId) return;

    const user = await userModel.findById(txRow.userId);
    if (user?.smsOptOut) {
      console.log(`[${transactionId}] SMS notifications skipped (User Opted Out)`);
      return;
    }

    const ref = txRow?.referenceNumber ?? transactionId;
    await smsService.notifyTransactionEvent(phoneNumber, {
      referenceNumber: ref,
      type: "withdraw",
      amount: String(amount),
      provider,
      kind,
      errorMessage,
    });
  } catch (smsErr) {
    logger.error(`[${transactionId}] SMS notification error`, smsErr);
  }
}

/**
 * Fetch pending MTN payouts from the database
 */
async function fetchPendingPayouts(provider: string): Promise<PendingPayout[]> {
  const result = await transactionModel.findByStatusAndProvider(
    TransactionStatus.Pending,
    provider,
    "withdraw",
    BATCH_SIZE,
  );

  return result.map(tx => ({
    transactionId: tx.id,
    phoneNumber: tx.phoneNumber,
    amount: String(tx.amount),
    provider: tx.provider,
  }));
}

/**
 * Process batch payout results and update individual transactions
 */
async function processBatchResults(
  results: BatchPayoutResult[],
  payouts: PendingPayout[],
): Promise<void> {
  const resultMap = new Map(results.map(r => [r.referenceId, r]));

  for (const payout of payouts) {
    const result = resultMap.get(payout.transactionId);

    if (!result) {
      logger.error(`[${payout.transactionId}] No result returned from batch`);
      await transactionModel.updateStatus(
        payout.transactionId,
        TransactionStatus.Failed,
      );
      await transactionModel.patchMetadata(payout.transactionId, {
        batchError: "No result returned from batch processing",
      });
      continue;
    }

    if (result.success) {
      await transactionModel.updateStatus(
        payout.transactionId,
        TransactionStatus.Completed,
      );

      if (result.providerReference) {
        await transactionModel.patchMetadata(payout.transactionId, {
          providerReference: result.providerReference,
        });
      }

      await notifyTransactionWebhook(payout.transactionId, "transaction.completed", {
        transactionModel,
        webhookService,
      });
      await sendTransactionEmail(payout.transactionId);
      await sendTransactionPush(payout.transactionId, "completed");
      await sendTxnSms(
        payout.transactionId,
        payout.phoneNumber,
        payout.amount,
        payout.provider,
        "transaction_completed",
      );

      await rabbitMQManager.publish(
        EXCHANGES.TRANSACTIONS,
        ROUTING_KEYS.TRANSACTION_COMPLETED,
        { transactionId: payout.transactionId, status: "completed" },
      );

      console.log(`[${payout.transactionId}] Batch payout completed successfully`);
    } else {
      const errorMsg = result.error || "Batch payout failed";
      
      await transactionModel.updateStatus(
        payout.transactionId,
        TransactionStatus.Failed,
      );
      await transactionModel.patchMetadata(payout.transactionId, {
        batchError: errorMsg,
      });

      await notifyTransactionWebhook(payout.transactionId, "transaction.failed", {
        transactionModel,
        webhookService,
      });
      await sendFailureEmail(payout.transactionId, errorMsg);
      await sendTransactionPush(payout.transactionId, "failed", errorMsg);
      await sendTxnSms(
        payout.transactionId,
        payout.phoneNumber,
        payout.amount,
        payout.provider,
        "transaction_failed",
        errorMsg,
      );

      await rabbitMQManager.publish(
        EXCHANGES.TRANSACTIONS,
        ROUTING_KEYS.TRANSACTION_FAILED,
        { transactionId: payout.transactionId, status: "failed", error: errorMsg },
      );

      console.log(`[${payout.transactionId}] Batch payout failed: ${errorMsg}`);
    }
  }
}

/**
 * Process a single batch of payouts for a provider
 */
async function processBatch(provider: string): Promise<void> {
  const payouts = await fetchPendingPayouts(provider);

  if (payouts.length === 0) {
    return;
  }

  console.log(`[BatchPayoutWorker] Processing ${payouts.length} pending ${provider} payouts`);

  const batchItems: BatchPayoutItem[] = payouts.map(p => ({
    referenceId: p.transactionId,
    phoneNumber: p.phoneNumber,
    amount: p.amount,
  }));

  const startTime = Date.now();
  const result = await mobileMoneyService.sendBatchPayout(provider, batchItems);
  const durationMs = Date.now() - startTime;

  // Record metrics
  const successCount = result.results.filter(r => r.success).length;
  const failureCount = result.results.filter(r => !r.success).length;

  batchPayoutTotal.inc({ provider, status: result.success ? "success" : "partial" });
  batchPayoutItemsTotal.inc({ provider, status: "success" }, successCount);
  batchPayoutItemsTotal.inc({ provider, status: "failed" }, failureCount);
  batchPayoutDurationSeconds.observe({ provider }, durationMs / 1000);
  batchPayoutSize.observe({ provider }, payouts.length);

  console.log(
    `[BatchPayoutWorker] Batch completed in ${durationMs}ms: ${successCount}/${payouts.length} successful`,
  );

  await processBatchResults(result.results, payouts);
}

/**
 * Main batch worker loop
 */
let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

async function runBatchCycle(): Promise<void> {
  if (isRunning) {
    console.log("[BatchPayoutWorker] Previous cycle still running, skipping");
    return;
  }

  isRunning = true;
  try {
    for (const provider of SUPPORTED_PROVIDERS) {
      await processBatch(provider);
    }
  } catch (error) {
    logger.error("[BatchPayoutWorker] Error in batch cycle:", error);
  } finally {
    isRunning = false;
  }
}

export function startBatchPayoutWorker(): void {
  if (intervalId) {
    console.log("[BatchPayoutWorker] Already running");
    return;
  }

  console.log(`[BatchPayoutWorker] Starting with interval ${BATCH_INTERVAL_MS}ms`);
  
  // Run immediately on start
  runBatchCycle().catch(err => 
    logger.error("[BatchPayoutWorker] Initial cycle error:", err)
  );

  // Then run on interval
  intervalId = setInterval(() => {
    runBatchCycle().catch(err =>
      logger.error("[BatchPayoutWorker] Interval cycle error:", err)
    );
  }, BATCH_INTERVAL_MS);
}

export function stopBatchPayoutWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[BatchPayoutWorker] Stopped");
  }
}

export const batchPayoutWorker = {
  start: startBatchPayoutWorker,
  stop: stopBatchPayoutWorker,
  isRunning: () => isRunning,
};
