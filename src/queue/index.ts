import { rabbitMQManager } from "./rabbitmq";
import { transactionQueue } from "./transactionQueue";
import { closeWorker, transactionWorker } from "./worker";
import {
  providerBalanceAlertQueue,
  closeProviderBalanceAlertQueue,
  scheduleProviderBalanceAlertJob,
} from "./providerBalanceAlertQueue";
import {
  closeProviderBalanceAlertWorker,
  startProviderBalanceAlertWorker,
} from "./providerBalanceAlertWorker";
import { closeAccountMergeWorker } from "./accountMergeWorker";

export async function shutdownQueue(): Promise<void> {
  console.log("Shutting down queues...");
  await closeProviderBalanceAlertWorker().catch(() => undefined);
  await closeProviderBalanceAlertQueue().catch(() => undefined);
  await closeAccountMergeWorker().catch(() => undefined);
  await closeWorker().catch(() => undefined);
  await transactionQueue.close().catch(() => undefined);
  await rabbitMQManager.close().catch(() => undefined);
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

export { createQueueDashboard } from "./dashboard";
export {
  getQueueHealth,
  pauseQueueEndpoint,
  resumeQueueEndpoint,
} from "./health";
export {
  getQueueDepth,
  queueDepthHandler,
  queueDepthPrometheusHandler,
} from "./queueDepthMetrics";

export { queueOptions } from "./config";
export { deadLetterQueue, DLQ_NAME, capturePersistentFailure } from "./dlq";
export { startProviderBalanceAlertWorker, scheduleProviderBalanceAlertJob };

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

// Trace-ID propagation utilities
export { withTraceId, traceIdFromJob, childLoggerWithTrace, TRACE_ID_KEY } from "./trace";
