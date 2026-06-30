import { getRedisPubSub } from "./redisPubSub";
import type { PubSub } from "graphql-subscriptions";

// ---------------------------------------------------------------------------
// Singleton pubsub — Redis-backed in production, in-memory in tests
// ---------------------------------------------------------------------------

export const pubsub = getRedisPubSub();

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export enum SubscriptionChannels {
  TRANSACTION_CREATED = "transaction.created",
  TRANSACTION_UPDATED = "transaction.updated",
  TRANSACTION_COMPLETED = "transaction.completed",
  TRANSACTION_FAILED = "transaction.failed",

  DISPUTE_CREATED = "dispute.created",
  DISPUTE_UPDATED = "dispute.updated",
  DISPUTE_NOTE_ADDED = "dispute.note_added",

  BULK_IMPORT_JOB_UPDATED = "bulk_import_job.updated",
}

/**
 * Per-transaction channel — clients subscribe to this for targeted updates.
 * Using a dedicated channel per ID avoids broadcasting every update to every
 * subscriber and lets Redis fan-out only to interested connections.
 */
export function transactionChannel(id: string): string {
  return `TRANSACTION_UPDATED:${id}`;
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface TransactionCreatedPayload {
  id: string;
  referenceNumber: string;
  type: string;
  amount: string;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
  status: string;
  tags: string[];
  createdAt: string;
}

export interface TransactionUpdatedPayload {
  id: string;
  referenceNumber: string;
  status: string;
  updatedAt: string;
  jobProgress?: number | null;
  phoneNumber?: string;
  provider?: string;
  stellarAddress?: string;
}

export interface TransactionCompletedPayload {
  id: string;
  referenceNumber: string;
  status: string;
  completedAt: string;
}

export interface TransactionFailedPayload {
  id: string;
  referenceNumber: string;
  status: string;
  failedAt: string;
  error?: string;
}

export interface DisputeCreatedPayload {
  id: string;
  transactionId: string;
  reason: string;
  status: string;
  reportedBy: string | null;
  createdAt: string;
}

export interface DisputeUpdatedPayload {
  id: string;
  status: string;
  assignedTo: string | null;
  resolution: string | null;
  updatedAt: string;
}

export interface DisputeNoteAddedPayload {
  id: string;
  disputeId: string;
  author: string;
  note: string;
  createdAt: string;
}

export interface BulkImportJobUpdatedPayload {
  jobId: string;
  status: string;
  progress: {
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
  };
  errors: Array<{ row: number; error: string }>;
  completedAt: string | null;
}

// Type for the PubSub engine that includes asyncIterator
export type TypedPubSub = PubSub & {
  asyncIterator<T>(eventPaths: string | string[]): AsyncIterableIterator<T>;
  publish<T>(eventPath: string, payload: T): Promise<void>;
};
