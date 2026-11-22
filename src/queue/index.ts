import { closeWebhookRetryQueue } from "./webhookRetryQueue";
import { transactionQueue } from "./transactionQueue";
import { transactionWorker, closeWorker } from "./worker";
import { syncQueue } from "./syncQueue";
import { syncWorker, closeSyncWorker } from "./syncWorker";
import {
  accountingRetryQueue,
  closeAccountingRetryQueue,
} from "./accountingRetryQueue";
import {
  accountingRetryWorker,
  closeAccountingRetryWorker,
} from "./accountingRetryWorker";
import { connection } from "./config";
import { startProviderBalanceAlertWorker } from "./providerBalanceAlertWorker";
import { scheduleProviderBalanceAlertJob } from "./providerBalanceAlertQueue";
import { startScheduledJobs } from "./scheduler";
import {
  startAccountingTokenRefreshWorker,
  closeAccountingTokenRefreshWorker,
} from "./accountingTokenRefreshWorker";
import {
  startWebhookRetryWorker,
  closeWebhookRetryWorker,
} from "./webhookRetryWorker";
import { closeRefundWorker, refundQueue, refundWorker } from "./refundWorker";
import { closeBankDepositSettlementWorker } from "./bankDepositSettlementWorker";
import { bankDepositSettlementQueue } from "./bankDepositSettlementQueue";
import {
  closeReceivingAnchorWebhookWorker,
  startReceivingAnchorWebhookWorker,
} from "./receivingAnchorWebhookWorker";
import { closeReceivingAnchorWebhookQueue } from "../services/webhookService";
import { stopRedisBackpressureMonitor } from "./redisBackpressure";
import { stopTransactionOutboxRelay } from "./transactionOutbox";
import { Worker } from "bullmq";
import { BatchSyncThrottle } from "../workers/transactionWorker";

// Tiered priorities (#2446): hold back the batch-sync worker whenever
// refunds or payments are waiting on the transaction queue.
const batchSyncThrottle =
  syncWorker instanceof Worker &&
  process.env.NODE_ENV !== "test" &&
  process.env.TRANSACTION_PRIORITY_SYNC_THROTTLE !== "false"
    ? new BatchSyncThrottle(transactionQueue, syncWorker)
    : null;
batchSyncThrottle?.start();

export async function shutdownQueue(): Promise<void> {
  stopRedisBackpressureMonitor();
  stopTransactionOutboxRelay();
  batchSyncThrottle?.stop();
  await Promise.all([
    closeWorker().catch(() => undefined),
    closeSyncWorker().catch(() => undefined),
    closeAccountingRetryWorker().catch(() => undefined),
    transactionQueue.close().catch(() => undefined),
    syncQueue.close().catch(() => undefined),
    closeWebhookRetryWorker().catch(() => undefined),
    closeWebhookRetryQueue().catch(() => undefined),
    closeRefundWorker().catch(() => undefined),
    closeBankDepositSettlementWorker().catch(() => undefined),
    bankDepositSettlementQueue.close().catch(() => undefined),
    closeReceivingAnchorWebhookWorker().catch(() => undefined),
    closeReceivingAnchorWebhookQueue().catch(() => undefined),
  ]);
}

export {
  transactionQueue,
  addTransactionJob,
  dispatchTransactionJob,
  startTransactionOutboxRelay,
  addTransactionToQueue,
  calculateTransactionPriority,
  getJobById,
  getJobProgress,
  getQueueStats,
  pauseQueue,
  resumeQueue,
  drainQueue,
} from "./transactionQueue";
export {
  startRedisBackpressureMonitor,
  stopRedisBackpressureMonitor,
  redisBackpressureGuard,
  isBackpressureActive,
  getBackpressureState,
} from "./redisBackpressure";
export type {
  TransactionJobData,
  TransactionJobResult,
} from "./transactionQueue";

export {
  syncQueue,
  addSyncJob,
  getSyncJobById,
  getSyncQueueStats,
} from "./syncQueue";
export type { SyncJobData, SyncJobResult } from "./syncQueue";

export { transactionWorker, closeWorker };
export { syncWorker, closeSyncWorker };
export { createQueueDashboard, createDashboardAuthMiddleware } from "./dashboard";
export {
  getQueueHealth,
  pauseQueueEndpoint,
  resumeQueueEndpoint,
} from "./health";
export {
  getQueueStatsAggregate,
  queueDepthHandler,
  queueDepthPrometheusHandler,
} from "./queueDepthMetrics";

export { queueOptions } from "./config";
export { deadLetterQueue, DLQ_NAME, capturePersistentFailure } from "./dlq";
export { startDlqMonitor, stopDlqMonitor, replayDlqJob } from "./dlqWorker";
export { startProviderBalanceAlertWorker, scheduleProviderBalanceAlertJob };
export { startScheduledJobs };

// Accounting Retry Queue Exports
export {
  accountingRetryQueue,
  addAccountingRetryJob,
  getAccountingRetryJobById,
  getAccountingRetryQueueStats,
  retryAccountingOperation,
  closeAccountingRetryQueue,
} from "./accountingRetryQueue";
export type {
  AccountingRetryJobData,
  AccountingRetryJobResult,
} from "./accountingRetryQueue";
export {
  accountingRetryWorker,
  closeAccountingRetryWorker,
} from "./accountingRetryWorker";

// Account Merge Queue Exports
export {
  accountMergeQueue,
  addAccountMergeJob,
  addBatchAccountMergeJobs,
  getAccountMergeJobById,
  getAccountMergeQueueStats,
  pauseAccountMergeQueue,
  resumeAccountMergeQueue,
  drainAccountMergeQueue,
  closeAccountMergeQueue,
} from "./accountMergeQueue";
export type {
  AccountMergeJobData,
  AccountMergeJobResult,
} from "./accountMergeQueue";
export {
  accountMergeWorker,
  closeAccountMergeWorker,
} from "./accountMergeWorker";

export { startAccountingTokenRefreshWorker, closeAccountingTokenRefreshWorker };
export {
  startReceivingAnchorWebhookWorker,
  closeReceivingAnchorWebhookWorker,
} from "./receivingAnchorWebhookWorker";

export {
  startWebhookRetryWorker,
  closeWebhookRetryWorker,
} from "./webhookRetryWorker";

export {
  REFUND_QUEUE_NAME,
  refundQueue,
  refundWorker,
  addRefundJob,
  enqueueFailedPayoutRefunds,
  startRefundWorker,
  closeRefundWorker,
} from "./refundWorker";
export type { RefundJobData, RefundJobResult } from "./refundWorker";

// Trace-ID propagation utilities
export {
  withTraceId,
  traceIdFromJob,
  childLoggerWithTrace,
  TRACE_ID_KEY,
} from "./trace";

// Customer KYC Callback Queue Exports
export {
  CUSTOMER_CALLBACK_QUEUE_NAME,
  customerCallbackQueue,
  enqueueCustomerCallback,
  deliverCustomerCallback,
  customerCallbackWorker,
  startCustomerCallbackWorker,
  closeCustomerCallbackWorker,
  closeCustomerCallbackQueue,
} from "./customerCallbackQueue";
export type { CustomerCallbackJobData } from "./customerCallbackQueue";

export { startWebhookRetryBacklogWatcher } from "./webhookRetryQueue";

export {
  startBankDepositSettlementWorker,
  closeBankDepositSettlementWorker,
} from "./bankDepositSettlementWorker";
export {
  bankDepositSettlementQueue,
  enqueueBankDepositSettlement,
} from "./bankDepositSettlementQueue";
