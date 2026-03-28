import { GraphQLError } from "graphql";
import type {
  Dispute,
  DisputeNote,
  DisputeStatus,
  DisputeWithNotes,
  ReportFilter,
} from "../models/dispute";
import type { GraphQLContext } from "./context";
import { mapTransactionRow, type MappedTransaction } from "./transactionMapper";
import { TransactionStatus } from "../models/transaction";
import { createSubscriptionResolvers } from "./subscriptionResolvers";
import {
  SubscriptionChannels,
  type TransactionCreatedPayload,
  type DisputeCreatedPayload,
  type DisputeUpdatedPayload,
  type DisputeNoteAddedPayload,
} from "./subscriptions";

const VALID_DISPUTE_STATUSES: DisputeStatus[] = [
  "open",
  "investigating",
  "resolved",
  "rejected",
];

function formatNote(n: DisputeNote) {
  return {
    id: n.id,
    disputeId: n.disputeId,
    author: n.author,
    note: n.note,
    createdAt:
      n.createdAt instanceof Date
        ? n.createdAt.toISOString()
        : String(n.createdAt),
  };
}

function formatDispute(d: Dispute | DisputeWithNotes) {
  const notes =
    "notes" in d && Array.isArray(d.notes) ? d.notes.map(formatNote) : [];
  return {
    id: d.id,
    transactionId: d.transactionId,
    reason: d.reason,
    status: d.status,
    assignedTo: d.assignedTo,
    resolution: d.resolution,
    reportedBy: d.reportedBy,
    createdAt:
      d.createdAt instanceof Date
        ? d.createdAt.toISOString()
        : String(d.createdAt),
    updatedAt:
      d.updatedAt instanceof Date
        ? d.updatedAt.toISOString()
        : String(d.updatedAt),
    notes,
  };
}

function toGraphQLError(err: unknown, fallback: string): GraphQLError {
  const message = err instanceof Error ? err.message : fallback;
  const lower = message.toLowerCase();
  if (lower.includes("not found")) {
    return new GraphQLError(message, { extensions: { code: "NOT_FOUND" } });
  }
  if (lower.includes("already exists")) {
    return new GraphQLError(message, { extensions: { code: "CONFLICT" } });
  }
  if (
    lower.includes("cannot transition") ||
    lower.includes("resolution text") ||
    lower.includes("cannot assign") ||
    lower.includes("only allowed for completed")
  ) {
    return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
  }
  return new GraphQLError(message, { extensions: { code: "INTERNAL" } });
}

export const resolvers = {
  Query: {
    me: (
      _parent: unknown,
      _args: unknown,
      ctx: GraphQLContext,
    ): { id: string; subject: string } | null => {
      if (!ctx.auth.authenticated || !ctx.auth.subject) {
        return null;
      }
      return { id: ctx.auth.subject, subject: ctx.auth.subject };
    },

    transaction: async (
      _parent: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<MappedTransaction | null> => {
      const row = await ctx.transactionModel.findById(args.id);
      if (!row) return null;
      return mapTransactionRow(row as unknown as Record<string, unknown>);
    },

    transactions: async (
      _parent: unknown,
      args: { limit?: number | null; offset?: number | null },
      ctx: GraphQLContext,
    ): Promise<MappedTransaction[]> => {
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      const rows = await ctx.transactionModel.list(limit, offset);
      return rows.map((r) =>
        mapTransactionRow(r as unknown as Record<string, unknown>),
      );
    },

    transactionByReferenceNumber: async (
      _parent: unknown,
      args: { referenceNumber: string },
      ctx: GraphQLContext,
    ): Promise<MappedTransaction | null> => {
      const row = await ctx.transactionModel.findByReferenceNumber(
        args.referenceNumber,
      );
      if (!row) return null;
      return mapTransactionRow(row as unknown as Record<string, unknown>);
    },

    transactionsByTags: async (
      _parent: unknown,
      args: { tags: string[] },
      ctx: GraphQLContext,
    ): Promise<MappedTransaction[]> => {
      try {
        const rows = await ctx.transactionModel.findByTags(args.tags);
        return rows.map((r) =>
          mapTransactionRow(r as unknown as Record<string, unknown>),
        );
      } catch (err) {
        throw toGraphQLError(err, "Failed to query by tags");
      }
    },

    dispute: async (
      _parent: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ) => {
      try {
        const d = await ctx.disputeService.getDispute(args.id);
        return formatDispute(d);
      } catch (err) {
        if (err instanceof Error && err.message.includes("not found")) {
          return null;
        }
        throw toGraphQLError(err, "Failed to fetch dispute");
      }
    },

    disputeReport: async (
      _parent: unknown,
      args: { filter?: { from?: string | null; to?: string | null; assignedTo?: string | null } | null },
      ctx: GraphQLContext,
    ) => {
      const filter: ReportFilter = {};
      const f = args.filter;
      if (f?.from) {
        const d = new Date(f.from);
        if (isNaN(d.getTime())) {
          throw new GraphQLError('Invalid "from" date', {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        filter.from = d;
      }
      if (f?.to) {
        const d = new Date(f.to);
        if (isNaN(d.getTime())) {
          throw new GraphQLError('Invalid "to" date', {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        filter.to = d;
      }
      if (f?.assignedTo) filter.assignedTo = f.assignedTo;

      const r = await ctx.disputeService.generateReport(filter);
      return {
        generatedAt: r.generatedAt,
        summary: r.summary.map((s) => ({
          status: s.status,
          count: s.count,
          avgResolutionHours: s.avgResolutionHours,
        })),
        totals: r.totals,
      };
    },

    bulkImportJob: (
      _parent: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ) => {
      const job = ctx.getBulkImportJob(args.id);
      if (!job) return null;
      return {
        jobId: job.id,
        status: job.status,
        progress: {
          total: job.total,
          processed: job.processed,
          succeeded: job.succeeded,
          failed: job.failed,
        },
        errors: job.errors.map((e) => ({ row: e.row, error: e.error })),
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt?.toISOString() ?? null,
      };
    },
  },

  Mutation: {
    deposit: async (
      _parent: unknown,
      args: {
        input: {
          amount: string;
          phoneNumber: string;
          provider: string;
          stellarAddress: string;
        };
      },
      ctx: GraphQLContext,
    ) => {
      const { amount, phoneNumber, provider, stellarAddress } = args.input;
      try {
        return await ctx.lockManager.withLock(
          ctx.LockKeys.phoneNumber(phoneNumber),
          async () => {
            const transaction = await ctx.transactionModel.create({
              type: "deposit",
              amount,
              phoneNumber,
              provider,
              stellarAddress,
              status: TransactionStatus.Pending,
              tags: [],
            });
            const job = await ctx.addTransactionJob({
              transactionId: transaction.id,
              type: "deposit",
              amount,
              phoneNumber,
              provider,
              stellarAddress,
            });
            const mapped = mapTransactionRow(
              transaction as unknown as Record<string, unknown>,
            );
            
            // Publish transaction created event
            const createdPayload: TransactionCreatedPayload = {
              id: mapped.id,
              referenceNumber: mapped.referenceNumber,
              type: "deposit",
              amount: String(mapped.amount),
              phoneNumber: mapped.phoneNumber,
              provider: mapped.provider,
              stellarAddress: mapped.stellarAddress,
              status: "pending",
              tags: mapped.tags,
              createdAt: mapped.createdAt,
            };
            ctx.pubsub.publish(SubscriptionChannels.TRANSACTION_CREATED, createdPayload);
            
            return {
              transactionId: mapped.id,
              referenceNumber: mapped.referenceNumber,
              status: "pending",
              jobId: String(job.id),
            };
          },
          15000,
        );
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("Unable to acquire lock")
        ) {
          throw new GraphQLError(
            "Transaction already in progress for this phone number",
            { extensions: { code: "CONFLICT" } },
          );
        }
        throw toGraphQLError(err, "Transaction failed");
      }
    },

    withdraw: async (
      _parent: unknown,
      args: {
        input: {
          amount: string;
          phoneNumber: string;
          provider: string;
          stellarAddress: string;
        };
      },
      ctx: GraphQLContext,
    ) => {
      const { amount, phoneNumber, provider, stellarAddress } = args.input;
      try {
        const transaction = await ctx.transactionModel.create({
          type: "withdraw",
          amount,
          phoneNumber,
          provider,
          stellarAddress,
          status: TransactionStatus.Pending,
          tags: [],
        });
        const job = await ctx.addTransactionJob({
          transactionId: transaction.id,
          type: "withdraw",
          amount,
          phoneNumber,
          provider,
          stellarAddress,
        });
        const mapped = mapTransactionRow(
          transaction as unknown as Record<string, unknown>,
        );
        
        // Publish transaction created event
        const createdPayload: TransactionCreatedPayload = {
          id: mapped.id,
          referenceNumber: mapped.referenceNumber,
          type: "withdraw",
          amount: String(mapped.amount),
          phoneNumber: mapped.phoneNumber,
          provider: mapped.provider,
          stellarAddress: mapped.stellarAddress,
          status: "pending",
          tags: mapped.tags,
          createdAt: mapped.createdAt,
        };
        ctx.pubsub.publish(SubscriptionChannels.TRANSACTION_CREATED, createdPayload);
        
        return {
          transactionId: mapped.id,
          referenceNumber: mapped.referenceNumber,
          status: "pending",
          jobId: String(job.id),
        };
      } catch (err) {
        throw toGraphQLError(err, "Transaction failed");
      }
    },

    openDispute: async (
      _parent: unknown,
      args: {
        input: {
          transactionId: string;
          reason: string;
          reportedBy?: string | null;
        };
      },
      ctx: GraphQLContext,
    ) => {
      const { transactionId, reason, reportedBy } = args.input;
      if (!reason?.trim()) {
        throw new GraphQLError('Field "reason" is required', {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      try {
        const d = await ctx.disputeService.openDispute(
          transactionId,
          reason.trim(),
          reportedBy ?? undefined,
        );
        
        // Publish dispute created event
        const createdPayload: DisputeCreatedPayload = {
          id: d.id,
          transactionId: d.transactionId,
          reason: d.reason,
          status: d.status,
          reportedBy: d.reportedBy,
          createdAt: d.createdAt.toISOString(),
        };
        ctx.pubsub.publish(SubscriptionChannels.DISPUTE_CREATED, createdPayload);
        
        return formatDispute(d);
      } catch (err) {
        throw toGraphQLError(err, "Failed to open dispute");
      }
    },

    updateDisputeStatus: async (
      _parent: unknown,
      args: {
        input: {
          disputeId: string;
          status: string;
          resolution?: string | null;
          assignedTo?: string | null;
        };
      },
      ctx: GraphQLContext,
    ) => {
      const { disputeId, status, resolution, assignedTo } = args.input;
      if (!VALID_DISPUTE_STATUSES.includes(status as DisputeStatus)) {
        throw new GraphQLError(
          `status must be one of: ${VALID_DISPUTE_STATUSES.join(", ")}`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      try {
        await ctx.disputeService.updateStatus(
          disputeId,
          status as DisputeStatus,
          resolution ?? undefined,
          assignedTo ?? undefined,
        );
        const full = await ctx.disputeService.getDispute(disputeId);
        
        // Publish dispute updated event
        const updatedPayload: DisputeUpdatedPayload = {
          id: full.id,
          status: full.status,
          assignedTo: full.assignedTo,
          resolution: full.resolution,
          updatedAt: full.updatedAt.toISOString(),
        };
        ctx.pubsub.publish(SubscriptionChannels.DISPUTE_UPDATED, updatedPayload);
        
        return formatDispute(full);
      } catch (err) {
        throw toGraphQLError(err, "Failed to update dispute");
      }
    },

    assignDispute: async (
      _parent: unknown,
      args: { input: { disputeId: string; agentName: string } },
      ctx: GraphQLContext,
    ) => {
      const { disputeId, agentName } = args.input;
      if (!agentName?.trim()) {
        throw new GraphQLError('Field "agentName" is required', {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      try {
        await ctx.disputeService.assignToAgent(disputeId, agentName.trim());
        const full = await ctx.disputeService.getDispute(disputeId);
        
        // Publish dispute updated event
        const updatedPayload: DisputeUpdatedPayload = {
          id: full.id,
          status: full.status,
          assignedTo: full.assignedTo,
          resolution: full.resolution,
          updatedAt: full.updatedAt.toISOString(),
        };
        ctx.pubsub.publish(SubscriptionChannels.DISPUTE_UPDATED, updatedPayload);
        
        return formatDispute(full);
      } catch (err) {
        throw toGraphQLError(err, "Failed to assign dispute");
      }
    },

    addDisputeNote: async (
      _parent: unknown,
      args: {
        input: { disputeId: string; author: string; note: string };
      },
      ctx: GraphQLContext,
    ) => {
      const { disputeId, author, note } = args.input;
      if (!author?.trim()) {
        throw new GraphQLError('Field "author" is required', {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      if (!note?.trim()) {
        throw new GraphQLError('Field "note" is required', {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      try {
        const created = await ctx.disputeService.addNote(
          disputeId,
          author.trim(),
          note.trim(),
        );
        
        // Publish dispute note added event
        const notePayload: DisputeNoteAddedPayload = {
          id: created.id,
          disputeId: created.disputeId,
          author: created.author,
          note: created.note,
          createdAt: created.createdAt.toISOString(),
        };
        ctx.pubsub.publish(SubscriptionChannels.DISPUTE_NOTE_ADDED, notePayload);
        
        return formatNote(created);
      } catch (err) {
        throw toGraphQLError(err, "Failed to add note");
      }
    },
  },

  Transaction: {
    jobProgress: async (
      parent: MappedTransaction,
      _args: unknown,
      ctx: GraphQLContext,
    ): Promise<number | null> => {
      if (parent.status !== "pending") return null;
      const p = await ctx.getJobProgress(parent.id);
      return p;
    },
  },
};

// Create subscription resolvers with shared pubsub
let subscriptionPubSub: any;
function getSubscriptionPubSub() {
  if (!subscriptionPubSub) {
    const { PubSub } = require("graphql-subscriptions");
    subscriptionPubSub = new PubSub();
  }
  return subscriptionPubSub;
}

export const subscriptionResolvers = createSubscriptionResolvers(getSubscriptionPubSub());
