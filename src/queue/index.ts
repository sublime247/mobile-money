import { rabbitMQManager } from "./rabbitmq";
import { transactionQueue } from "./transactionQueue";
import { transactionWorker, closeWorker } from "./worker";
import { syncQueue } from "./syncQueue";
import { syncWorker, closeSyncWorker } from "./syncWorker";
import { accountingRetryQueue, closeAccountingRetryQueue } from "./accountingRetryQueue";
import { accountingRetryWorker, closeAccountingRetryWorker } from "./accountingRetryWorker";
import { connection } from "./config";
import { startProviderBalanceAlertWorker } from "./providerBalanceAlertWorker";
import { scheduleProviderBalanceAlertJob } from "./providerBalanceAlertQueue";
import { startAccountingTokenRefreshWorker, closeAccountingTokenRefreshWorker } from "./accountingTokenRefreshWorker";
import { startWebhookRetryWorker, closeWebhookRetryWorker } from "./webhookRetryWorker";

export async function shutdownQueue(): Promise<void> {
  await Promise.all([
    closeWorker().catch(() => undefined),
    closeSyncWorker().catch(() => undefined),
    closeAccountingRetryWorker().catch(() => undefined),
    transactionQueue.close().catch(() => undefined),
    syncQueue.close().catch(() => undefined),
    closeWebhookRetryWorker().catch(() => undefined),
  ]);
}

export {
  transactionQueue,
  addTransactionJob,
  getJobById,
  getJobProgress,
  getQueueStats,
  pauseQueue,
  resumeQueue,
  drainQueue,
} from "./transactionQueue";
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
export { createQueueDashboard } from "./dashboard";
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
export { startProviderBalanceAlertWorker, scheduleProviderBalanceAlertJob };

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

export {
  startAccountingTokenRefreshWorker,
  closeAccountingTokenRefreshWorker,
};

export {
  startWebhookRetryWorker,
  closeWebhookRetryWorker,
} from "./webhookRetryWorker";

// Trace-ID propagation utilities
export { withTraceId, traceIdFromJob, childLoggerWithTrace, TRACE_ID_KEY } from "./trace";
