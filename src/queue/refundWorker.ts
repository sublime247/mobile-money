import { Job, Queue, Worker } from "bullmq";
import logger from "../utils/logger";
import {
  Transaction,
  TransactionModel,
  TransactionStatus,
} from "../models/transaction";
import { LedgerService } from "../services/ledgerService";
import { StellarService } from "../services/stellar/stellarService";
import { notifyTransactionWebhook, WebhookService } from "../services/webhook";
import { connection, getRefundWorkerConcurrency } from "./config";
import { rabbitMQManager, EXCHANGES, ROUTING_KEYS } from "./rabbitmq";

export const REFUND_QUEUE_NAME = "failed-payout-refunds";

const REFUND_SCAN_LIMIT = parseInt(process.env.REFUND_SCAN_LIMIT || "100", 10);
const REFUND_SCAN_INTERVAL_MS = parseInt(
  process.env.REFUND_SCAN_INTERVAL_MS || "60000",
  10,
);

export interface RefundJobData {
  transactionId: string;
  reason: string;
}

export interface RefundJobResult {
  success: boolean;
  transactionId: string;
  refundHash?: string;
  error?: string;
}

const transactionModel = new TransactionModel();
const ledgerService = new LedgerService();
const stellarService = new StellarService();
const webhookService = new WebhookService();

export const refundQueue = new Queue<RefundJobData, RefundJobResult>(
  REFUND_QUEUE_NAME,
  { connection },
);

function getRefundMetadata(transaction: Transaction): Record<string, any> {
  const metadata = transaction.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

function getFailureReason(transaction: Transaction): string {
  const metadata = getRefundMetadata(transaction);
  return String(
    metadata.batchError ||
      metadata.providerError ||
      metadata.failureReason ||
      "Payout failed permanently",
  );
}

function hasCompletedRefund(transaction: Transaction): boolean {
  const refund = getRefundMetadata(transaction).refund;
  return Boolean(refund && typeof refund === "object" && refund.completedAt);
}

export async function addRefundJob(
  data: RefundJobData,
): Promise<{ id: string | undefined }> {
  const job = await refundQueue.add("refund-failed-payout", data, {
    jobId: data.transactionId,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 5000 },
  });

  return { id: job.id };
}

export async function enqueueFailedPayoutRefunds(): Promise<number> {
  const transactions =
    await transactionModel.findRefundableFailedPayouts(REFUND_SCAN_LIMIT);

  let queued = 0;
  for (const transaction of transactions) {
    if (hasCompletedRefund(transaction)) {
      continue;
    }

    const reason = getFailureReason(transaction);
    await addRefundJob({ transactionId: transaction.id, reason });
    await transactionModel.patchMetadata(transaction.id, {
      refundQueuedAt: new Date().toISOString(),
      refundReason: reason,
    });
    queued += 1;
  }

  return queued;
}

async function processRefundJob(
  job: Job<RefundJobData>,
): Promise<RefundJobResult> {
  const { transactionId, reason } = job.data;
  const transaction = await transactionModel.findById(transactionId);

  if (!transaction) {
    return { success: false, transactionId, error: "Transaction not found" };
  }

  if (
    transaction.type !== "withdraw" ||
    transaction.status !== TransactionStatus.Failed ||
    hasCompletedRefund(transaction)
  ) {
    return { success: true, transactionId };
  }

  await transactionModel.patchMetadata(transactionId, {
    refund: {
      status: "processing",
      reason,
      startedAt: new Date().toISOString(),
    },
  });

  const amount = String(transaction.amount);
  const refundResult = await stellarService.sendRefundPayment(
    transaction.stellarAddress,
    amount,
    "Mobile Money Refunds",
    transaction.userId,
    true,
  );

  await ledgerService.postWithdrawalRefund(
    Number(amount),
    transaction.referenceNumber,
    transactionId,
    transaction.userId,
    reason,
    refundResult.hash,
  );

  await transactionModel.updateStatus(
    transactionId,
    TransactionStatus.Reversed,
  );
  await transactionModel.patchMetadata(transactionId, {
    refund: {
      status: "completed",
      reason,
      hash: refundResult.hash || null,
      completedAt: new Date().toISOString(),
    },
    stellar: {
      transactionHash: refundResult.hash,
      envelope: refundResult.envelope,
      submittedAt: (refundResult.submittedAt ?? new Date()).toISOString(),
      baseFee: 100,
      refundMethod: refundResult.method,
    },
  });

  await notifyTransactionWebhook(transactionId, "transaction.refunded" as any, {
    transactionModel,
    webhookService,
  });

  await rabbitMQManager.publish(
    EXCHANGES.TRANSACTIONS,
    ROUTING_KEYS.TRANSACTION_COMPLETED,
    { transactionId, status: "refunded", refundHash: refundResult.hash },
  );

  return {
    success: true,
    transactionId,
    refundHash: refundResult.hash,
  };
}

export const refundWorker = new Worker<RefundJobData, RefundJobResult>(
  REFUND_QUEUE_NAME,
  processRefundJob,
  { connection, concurrency: getRefundWorkerConcurrency() },
);

refundWorker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, result }, "Refund job completed");
});

refundWorker.on("failed", async (job, error) => {
  logger.error({ jobId: job?.id, error }, "Refund job failed");
  if (job?.data.transactionId) {
    await transactionModel.patchMetadata(job.data.transactionId, {
      refund: {
        status: "failed",
        reason: job.data.reason,
        error: error.message,
        failedAt: new Date().toISOString(),
      },
    });
  }
});

let scanInterval: NodeJS.Timeout | null = null;

export function startRefundWorker(): void {
  if (scanInterval) {
    return;
  }

  enqueueFailedPayoutRefunds().catch((error) =>
    logger.error({ error }, "Initial failed payout refund scan failed"),
  );

  scanInterval = setInterval(() => {
    enqueueFailedPayoutRefunds().catch((error) =>
      logger.error({ error }, "Failed payout refund scan failed"),
    );
  }, REFUND_SCAN_INTERVAL_MS);
}

export async function closeRefundWorker(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  await Promise.all([refundWorker.close(), refundQueue.close()]);
}
