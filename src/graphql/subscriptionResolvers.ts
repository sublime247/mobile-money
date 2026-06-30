import { withFilter } from "graphql-subscriptions";
import {
  SubscriptionChannels,
  transactionChannel,
  type TransactionCreatedPayload,
  type TransactionUpdatedPayload,
  type DisputeCreatedPayload,
  type DisputeUpdatedPayload,
  type DisputeNoteAddedPayload,
  type BulkImportJobUpdatedPayload,
  type TypedPubSub,
} from "./subscriptions";

// ---------------------------------------------------------------------------
// Payload formatters
// ---------------------------------------------------------------------------

function formatTransactionPayload(
  payload: TransactionCreatedPayload | TransactionUpdatedPayload,
) {
  const base: Record<string, unknown> = {
    id: payload.id,
    referenceNumber: payload.referenceNumber,
    status: payload.status,
    retryCount: 0,
  };

  if ("type" in payload) {
    base.type = payload.type;
    base.amount = payload.amount;
    base.phoneNumber = payload.phoneNumber;
    base.provider = payload.provider;
    base.stellarAddress = payload.stellarAddress;
    base.tags = payload.tags;
    base.createdAt = payload.createdAt;
  }

  if ("updatedAt" in payload) base.updatedAt = payload.updatedAt;
  if ("jobProgress" in payload) base.jobProgress = payload.jobProgress;

  return base;
}

function formatDisputePayload(
  payload: DisputeCreatedPayload | DisputeUpdatedPayload,
) {
  const base: Record<string, unknown> = {
    id: payload.id,
    status: payload.status,
    notes: [],
  };

  if ("transactionId" in payload) {
    base.transactionId = payload.transactionId;
    base.reason = payload.reason;
    base.reportedBy = payload.reportedBy;
    base.createdAt = payload.createdAt;
  }

  if ("assignedTo" in payload) {
    base.assignedTo = payload.assignedTo;
    base.resolution = payload.resolution;
    base.updatedAt = payload.updatedAt;
  }

  return base;
}

function formatDisputeNotePayload(payload: DisputeNoteAddedPayload) {
  return {
    id: payload.id,
    disputeId: payload.disputeId,
    author: payload.author,
    note: payload.note,
    createdAt: payload.createdAt,
  };
}

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
// Subscription resolvers factory
// ---------------------------------------------------------------------------

export function createSubscriptionResolvers(pubsub: TypedPubSub) {
  return {
    Subscription: {
      // ── transactionUpdated ──────────────────────────────────────────────
      // Subscribes to a per-transaction Redis channel so only the relevant
      // connection receives the event — no server-side filtering needed.
      transactionUpdated: {
        subscribe: (_parent: unknown, args: { id: string }, context: any) => {
          // Reject unauthenticated WS connections
          if (!context?.auth?.authenticated) {
            throw new Error("UNAUTHENTICATED: valid authToken required");
          }
          // Subscribe to the per-transaction channel
          const channel = args.id
            ? transactionChannel(args.id)
            : SubscriptionChannels.TRANSACTION_UPDATED;
          return pubsub.asyncIterator<TransactionUpdatedPayload>(channel);
        },
        resolve: (payload: TransactionUpdatedPayload) =>
          formatTransactionPayload(payload),
      },

      // ── transactionCreated ──────────────────────────────────────────────
      transactionCreated: {
        subscribe: (_parent: unknown, _args: unknown, context: any) => {
          if (!context?.auth?.authenticated) {
            throw new Error("UNAUTHENTICATED: valid authToken required");
          }
          return pubsub.asyncIterator<TransactionCreatedPayload>(
            SubscriptionChannels.TRANSACTION_CREATED,
          );
        },
        resolve: (payload: TransactionCreatedPayload) =>
          formatTransactionPayload(payload),
      },

      // ── transactionCompleted ────────────────────────────────────────────
      transactionCompleted: {
        subscribe: (_parent: unknown, _args: unknown, context: any) => {
          if (!context?.auth?.authenticated) {
            throw new Error("UNAUTHENTICATED: valid authToken required");
          }
          return pubsub.asyncIterator<TransactionUpdatedPayload>(
            SubscriptionChannels.TRANSACTION_COMPLETED,
          );
        },
        resolve: (payload: TransactionUpdatedPayload) =>
          formatTransactionPayload(payload),
      },

      // ── transactionFailed ───────────────────────────────────────────────
      transactionFailed: {
        subscribe: (_parent: unknown, _args: unknown, context: any) => {
          if (!context?.auth?.authenticated) {
            throw new Error("UNAUTHENTICATED: valid authToken required");
          }
          return pubsub.asyncIterator<TransactionUpdatedPayload>(
            SubscriptionChannels.TRANSACTION_FAILED,
          );
        },
        resolve: (payload: TransactionUpdatedPayload) =>
          formatTransactionPayload(payload),
      },

      // ── disputeCreated ──────────────────────────────────────────────────
      disputeCreated: {
        subscribe: (_parent: unknown, _args: unknown, context: any) => {
          if (!context?.auth?.authenticated) {
            throw new Error("UNAUTHENTICATED: valid authToken required");
          }
          return pubsub.asyncIterator<DisputeCreatedPayload>(
            SubscriptionChannels.DISPUTE_CREATED,
          );
        },
        resolve: (payload: DisputeCreatedPayload) =>
          formatDisputePayload(payload),
      },

      // ── disputeUpdated ──────────────────────────────────────────────────
      disputeUpdated: {
        subscribe: withFilter(
          (_parent: unknown, _args: unknown, context: any) => {
            if (!context?.auth?.authenticated) {
              throw new Error("UNAUTHENTICATED: valid authToken required");
            }
            return pubsub.asyncIterator<DisputeUpdatedPayload>(
              SubscriptionChannels.DISPUTE_UPDATED,
            );
          },
          (payload: any, variables: any) => {
            if (!variables?.id) return true;
            return payload?.id === variables.id;
          },
        ),
        resolve: (payload: DisputeUpdatedPayload) =>
          formatDisputePayload(payload),
      },

      // ── disputeNoteAdded ────────────────────────────────────────────────
      disputeNoteAdded: {
        subscribe: withFilter(
          (_parent: unknown, _args: unknown, context: any) => {
            if (!context?.auth?.authenticated) {
              throw new Error("UNAUTHENTICATED: valid authToken required");
            }
            return pubsub.asyncIterator<DisputeNoteAddedPayload>(
              SubscriptionChannels.DISPUTE_NOTE_ADDED,
            );
          },
          (payload: any, variables: any) => {
            if (!variables?.disputeId) return true;
            return payload?.disputeId === variables.disputeId;
          },
        ),
        resolve: (payload: DisputeNoteAddedPayload) =>
          formatDisputeNotePayload(payload),
      },

      // ── bulkImportJobUpdated ────────────────────────────────────────────
      bulkImportJobUpdated: {
        subscribe: withFilter(
          (_parent: unknown, _args: unknown, context: any) => {
            if (!context?.auth?.authenticated) {
              throw new Error("UNAUTHENTICATED: valid authToken required");
            }
            return pubsub.asyncIterator<BulkImportJobUpdatedPayload>(
              SubscriptionChannels.BULK_IMPORT_JOB_UPDATED,
            );
          },
          (payload: any, variables: any) => payload?.jobId === variables.jobId,
        ),
        resolve: (payload: BulkImportJobUpdatedPayload) =>
          formatBulkImportJobPayload(payload),
      },
    },
  };
}
