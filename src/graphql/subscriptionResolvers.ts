import { withFilter } from "graphql-subscriptions";
import type { PubSubEngine } from "graphql-subscriptions";
import {
  SubscriptionChannels,
  type TransactionCreatedPayload,
  type TransactionUpdatedPayload,
  type DisputeCreatedPayload,
  type DisputeUpdatedPayload,
  type DisputeNoteAddedPayload,
  type BulkImportJobUpdatedPayload,
  type TypedPubSub,
} from "./subscriptions";


/**
 * Formats a transaction payload for subscription responses
 */
function formatTransactionPayload(payload: TransactionCreatedPayload | TransactionUpdatedPayload) {
  const basePayload: any = {
    id: payload.id,
    referenceNumber: payload.referenceNumber,
    status: payload.status,
    retryCount: 0,
  };
  
  // Add optional fields based on payload type
  if ("type" in payload && payload.type) {
    basePayload.type = payload.type;
    basePayload.amount = payload.amount;
    basePayload.phoneNumber = payload.phoneNumber;
    basePayload.provider = payload.provider;
    basePayload.stellarAddress = payload.stellarAddress;
    basePayload.tags = payload.tags;
    basePayload.createdAt = payload.createdAt;
  }
  
  if ("updatedAt" in payload && payload.updatedAt) {
    basePayload.updatedAt = payload.updatedAt;
  }
  
  if ("jobProgress" in payload) {
    basePayload.jobProgress = payload.jobProgress;
  }
  
  return basePayload;
}

/**
 * Formats a dispute payload for subscription responses
 */
function formatDisputePayload(payload: DisputeCreatedPayload | DisputeUpdatedPayload) {
  const basePayload: any = {
    id: payload.id,
    status: payload.status,
    notes: [],
  };
  
  // Add optional fields based on payload type
  if ("transactionId" in payload && payload.transactionId) {
    basePayload.transactionId = payload.transactionId;
    basePayload.reason = payload.reason;
    basePayload.reportedBy = payload.reportedBy;
    basePayload.createdAt = payload.createdAt;
  }
  
  if ("assignedTo" in payload) {
    basePayload.assignedTo = payload.assignedTo;
    basePayload.resolution = payload.resolution;
  }
  
  if ("updatedAt" in payload && payload.updatedAt) {
    basePayload.updatedAt = payload.updatedAt;
  }
  
  return basePayload;
}

/**
 * Formats a dispute note payload for subscription responses
 */
function formatDisputeNotePayload(payload: DisputeNoteAddedPayload) {
  return {
    id: payload.id,
    disputeId: payload.disputeId,
    author: payload.author,
    note: payload.note,
    createdAt: payload.createdAt,
  };
}

/**
 * Formats a bulk import job payload for subscription responses
 */
function formatBulkImportJobPayload(payload: BulkImportJobUpdatedPayload) {
  return {
    jobId: payload.jobId,
    status: payload.status,
    progress: payload.progress,
    errors: payload.errors,
    createdAt: new Date().toISOString(),
    completedAt: payload.completedAt,
  };
}

// ---------------------------------------------------------------------------
// Subscription Resolvers
// ---------------------------------------------------------------------------

export function createSubscriptionResolvers(pubsub: TypedPubSub) {
  return {
    Subscription: {
      // Transaction subscriptions
      transactionCreated: {
        subscribe: () =>
          pubsub.asyncIterator<TransactionCreatedPayload>([
            SubscriptionChannels.TRANSACTION_CREATED,
          ]),
        resolve: (payload: TransactionCreatedPayload) => ({
          ...formatTransactionPayload(payload),
        }),
      },

      transactionUpdated: {
        subscribe: withFilter(
          () =>
            pubsub.asyncIterator<TransactionUpdatedPayload>([
              SubscriptionChannels.TRANSACTION_UPDATED,
            ]),
          (payload: any, _variables: any, _context: any, _info: any) => {
            // If no ID specified, broadcast to all
            if (!_variables?.id) return true;
            // Only send updates for the specific transaction
            return payload?.id === _variables.id;
          },
        ),
        resolve: (payload: TransactionUpdatedPayload) => ({
          ...formatTransactionPayload(payload),
        }),
      },

      transactionCompleted: {
        subscribe: () =>
          pubsub.asyncIterator<TransactionUpdatedPayload>([
            SubscriptionChannels.TRANSACTION_COMPLETED,
          ]),
        resolve: (payload: TransactionUpdatedPayload) => ({
          ...formatTransactionPayload(payload),
        }),
      },

      transactionFailed: {
        subscribe: () =>
          pubsub.asyncIterator<TransactionUpdatedPayload>([
            SubscriptionChannels.TRANSACTION_FAILED,
          ]),
        resolve: (payload: TransactionUpdatedPayload) => ({
          ...formatTransactionPayload(payload),
        }),
      },

      // Dispute subscriptions
      disputeCreated: {
        subscribe: () =>
          pubsub.asyncIterator<DisputeCreatedPayload>([
            SubscriptionChannels.DISPUTE_CREATED,
          ]),
        resolve: (payload: DisputeCreatedPayload) => formatDisputePayload(payload),
      },

      disputeUpdated: {
        subscribe: withFilter(
          () =>
            pubsub.asyncIterator<DisputeUpdatedPayload>([
              SubscriptionChannels.DISPUTE_UPDATED,
            ]),
          (payload: any, _variables: any, _context: any, _info: any) => {
            // If no ID specified, broadcast to all
            if (!_variables?.id) return true;
            // Only send updates for the specific dispute
            return payload?.id === _variables.id;
          },
        ),
        resolve: (payload: DisputeUpdatedPayload) => formatDisputePayload(payload),
      },

      disputeNoteAdded: {
        subscribe: withFilter(
          () =>
            pubsub.asyncIterator<DisputeNoteAddedPayload>([
              SubscriptionChannels.DISPUTE_NOTE_ADDED,
            ]),
          (payload: any, _variables: any, _context: any, _info: any) => {
            // If no disputeId specified, broadcast to all
            if (!_variables?.disputeId) return true;
            // Only send notes for the specific dispute
            return payload?.disputeId === _variables.disputeId;
          },
        ),
        resolve: (payload: DisputeNoteAddedPayload) => formatDisputeNotePayload(payload),
      },

      // Bulk import job subscriptions
      bulkImportJobUpdated: {
        subscribe: withFilter(
          () =>
            pubsub.asyncIterator<BulkImportJobUpdatedPayload>([
              SubscriptionChannels.BULK_IMPORT_JOB_UPDATED,
            ]),
          (payload: any, _variables: any, _context: any, _info: any) => {
            // Only send updates for the specific job
            return payload?.jobId === _variables.jobId;
          },
        ),
        resolve: (payload: BulkImportJobUpdatedPayload) => formatBulkImportJobPayload(payload),
      },
    },
  };
}
