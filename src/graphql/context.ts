import type { Request } from "express";
import { GraphQLError } from "graphql";
import { PubSub } from "graphql-subscriptions";
import { TransactionModel } from "../models/transaction";
import { DisputeService } from "../services/dispute";
import { lockManager, LockKeys } from "../utils/lock";
import { addTransactionJob, getJobProgress } from "../queue";
import { getBulkImportJob } from "../routes/bulk";
import type { TypedPubSub } from "./subscriptions";

const transactionModel = new TransactionModel();
const disputeService = new DisputeService();
const pubsub = new PubSub() as unknown as TypedPubSub;

export interface GraphQLAuth {
  authenticated: boolean;
  subject: string | null;
}

export interface GraphQLContext {
  auth: GraphQLAuth;
  transactionModel: TransactionModel;
  disputeService: DisputeService;
  lockManager: typeof lockManager;
  LockKeys: typeof LockKeys;
  addTransactionJob: typeof addTransactionJob;
  getJobProgress: typeof getJobProgress;
  getBulkImportJob: typeof getBulkImportJob;
  pubsub: TypedPubSub;
}

function resolveAuth(req: Request): GraphQLAuth {
  const expected = process.env.GRAPHQL_API_KEY?.trim();
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      throw new GraphQLError(
        "GRAPHQL_API_KEY must be set when NODE_ENV is production",
        { extensions: { code: "UNAUTHENTICATED" } },
      );
    }
    return { authenticated: false, subject: null };
  }

  const header = req.headers["x-api-key"];
  const raw = Array.isArray(header) ? header[0] : header;
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7).trim()
    : undefined;
  const provided = raw || bearer;
  if (!provided || provided !== expected) {
    throw new GraphQLError("Invalid or missing API key", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return {
    authenticated: true,
    subject: process.env.GRAPHQL_CLIENT_SUBJECT?.trim() || "api-client",
  };
}

export function buildGraphqlContext(req: Request): GraphQLContext {
  const auth = resolveAuth(req);
  return {
    auth,
    transactionModel,
    disputeService,
    lockManager,
    LockKeys,
    addTransactionJob,
    getJobProgress,
    getBulkImportJob,
    pubsub,
  };
}
