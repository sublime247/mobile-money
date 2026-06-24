import { rabbitMQManager, EXCHANGES, ROUTING_KEYS } from "./rabbitmq";
import { TransactionModel, TransactionStatus } from "../models/transaction";

export const TRANSACTION_QUEUE_NAME = "transaction-processing-queue";

const transactionModel = new TransactionModel();

export interface TransactionJobData {
  transactionId: string;
  type: "deposit" | "withdraw";
  amount: string;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
  /** IP address of the originating client, forwarded through the queue for blacklist enforcement. */
  clientIp?: string;
  requestId?: string;
  _traceId?: string;
}

export interface TransactionJobResult {
  success: boolean;
  transactionId: string;
  error?: string;
}

// Keeping this for compatibility, but it's no longer a BullMQ.Queue
export const transactionQueue = {
  close: async () => {}, // No-op as rabbitMQManager handles it
  getName: () => TRANSACTION_QUEUE_NAME,
};

export async function addTransactionJob(
  data: TransactionJobData,
  options?: {
    priority?: number;
    delay?: number;
    repeat?: { every: number };
    jobId?: string;
  },
) {
  // Use RabbitMQ Topic Exchange for advanced routing
  await rabbitMQManager.publish(
    EXCHANGES.TRANSACTIONS,
    ROUTING_KEYS.TRANSACTION_PROCESS,
    data
  );
  
  console.log(`[Queue] Added transaction job to RabbitMQ: ${data.transactionId}`);
  return { id: data.transactionId }; // Return something compatible
}

export async function getJobById(jobId: string) {
  // Try to find in DB as a proxy
  return await transactionModel.findById(jobId);
}

export async function getJobProgress(jobId: string): Promise<number> {
  const transaction = await transactionModel.findById(jobId);
  if (!transaction) return 0;
  
  // Try to get from metadata.progress
  const progress = (transaction.metadata as any)?.progress;
  if (typeof progress === "number") return progress;
  
  // Fallback to status proxy
  if (transaction.status === TransactionStatus.Completed) return 100;
  if (transaction.status === TransactionStatus.Failed) return 0;
  return 0;
}

export async function getQueueStats() {
  const [pending, completed, failed] = await Promise.all([
    transactionModel.countByStatuses([TransactionStatus.Pending]),
    transactionModel.countByStatuses([TransactionStatus.Completed]),
    transactionModel.countByStatuses([TransactionStatus.Failed]),
  ]);

  return {
    waiting: pending, 
    active: 0, // RabbitMQ doesn't easily expose this through this client
    completed,
    failed,
    isPaused: false, // RabbitMQ specific pausing needs more setup
  };
}

export async function pauseQueue() {
  // Needs integration with RabbitMQ consumer control
  console.warn("pauseQueue not fully implemented for RabbitMQ migration");
}

export async function resumeQueue() {
  console.warn("resumeQueue not fully implemented for RabbitMQ migration");
}

export async function drainQueue() {
  // Purging a queue in RabbitMQ
  console.warn("drainQueue not fully implemented for RabbitMQ migration");
}

