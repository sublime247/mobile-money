import logger from "../utils/logger";
import { Worker, Job } from "bullmq";
import * as StellarSdk from "stellar-sdk";
import { queueOptions } from "./config";
import {
  AccountMergeJobData,
  AccountMergeJobResult,
  ACCOUNT_MERGE_QUEUE_NAME,
} from "./accountMergeQueue";
import { getNetworkPassphrase, getStellarServer } from "../config/stellar";
import { capturePersistentFailure } from "./dlq";

const ACCOUNT_MERGE_PREFIX = "[account-merge]";
const STROOPS_PER_XLM = 10_000_000n;
const BASE_FEE_STROOPS = BigInt(StellarSdk.BASE_FEE.toString());

interface AccountMergeCandidate {
  nativeBalance: string;
  subentryCount: number;
  hasNonNativeBalances: boolean;
  lastActivityAt: Date | null;
}

type AccountBalance = {
  asset_type: string;
  balance: string;
};

type AccountWithBalances = {
  balances: AccountBalance[];
};

function xlmToStroops(amount: string): bigint {
  const normalized = amount.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(normalized)) {
    throw new Error(`Invalid XLM amount: ${amount}`);
  }

  const [wholePart, fractionalPart = ""] = normalized.split(".");
  const paddedFraction = `${fractionalPart}0000000`.slice(0, 7);

  return BigInt(wholePart) * STROOPS_PER_XLM + BigInt(paddedFraction);
}

function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function evaluateAccountMergeCandidate(
  candidate: AccountMergeCandidate,
  inactivityDays: number,
  now: Date = new Date(),
): { eligible: boolean; reason?: string; reclaimableBalance: string } {
  const nativeBalanceStroops = xlmToStroops(candidate.nativeBalance);
  const reclaimableStroops = nativeBalanceStroops - BASE_FEE_STROOPS;
  const reclaimableBalance =
    reclaimableStroops > 0n ? stroopsToXlm(reclaimableStroops) : "0";

  if (nativeBalanceStroops <= BASE_FEE_STROOPS) {
    return {
      eligible: false,
      reason: "native balance is too low to reclaim after fees",
      reclaimableBalance,
    };
  }

  if (candidate.subentryCount > 0) {
    return {
      eligible: false,
      reason: `account still has ${candidate.subentryCount} subentries`,
      reclaimableBalance,
    };
  }

  if (candidate.hasNonNativeBalances) {
    return {
      eligible: false,
      reason: "account still holds non-native assets",
      reclaimableBalance,
    };
  }

  if (candidate.lastActivityAt) {
    const inactivityCutoff = new Date(now);
    inactivityCutoff.setDate(inactivityCutoff.getDate() - inactivityDays);

    if (candidate.lastActivityAt > inactivityCutoff) {
      return {
        eligible: false,
        reason: `account was active within the last ${inactivityDays} day(s)`,
        reclaimableBalance,
      };
    }
  }

  return {
    eligible: true,
    reclaimableBalance,
  };
}

function getNativeBalance(account: AccountWithBalances): string {
  const nativeBalance = account.balances.find(
    (balance) => balance.asset_type === "native",
  );
  return nativeBalance?.balance ?? "0";
}

function hasNonNativeBalances(account: AccountWithBalances): boolean {
  return account.balances.some(
    (balance) =>
      balance.asset_type !== "native" && Number.parseFloat(balance.balance) > 0,
  );
}

async function fetchLastActivityAt(
  server: StellarSdk.Horizon.Server,
  publicKey: string,
): Promise<Date | null> {
  try {
    const response = await server
      .transactions()
      .forAccount(publicKey)
      .order("desc")
      .limit(1)
      .call();

    const latestTransaction = response.records[0];
    return latestTransaction ? new Date(latestTransaction.created_at) : null;
  } catch {
    return null;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeResponse = error as { response?: { status?: number } };
  return maybeResponse.response?.status === 404;
}

const workerOptions = {
  ...queueOptions,
  concurrency: 1, // Account merges should run sequentially to avoid nonce issues
  limiter: {
    max: 5,
    duration: 10000, // Rate limit: 5 merges per 10 seconds
  },
};

export const accountMergeWorker = new Worker<
  AccountMergeJobData,
  AccountMergeJobResult
>(
  ACCOUNT_MERGE_QUEUE_NAME,
  async (job: Job<AccountMergeJobData, AccountMergeJobResult>) => {
    const { sourceSecret, destinationPublicKey, inactivityDays, dryRun } = job.data;
    const server = getStellarServer();

    await job.updateProgress(10);

    let sourceKeypair: StellarSdk.Keypair;
    try {
      sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecret);
    } catch {
      return {
        success: false,
        sourcePublicKey: "invalid",
        destinationPublicKey,
        reclaimedXLM: "0",
        error: "Invalid source secret",
      };
    }

    const sourcePublicKey = sourceKeypair.publicKey();

    if (sourcePublicKey === destinationPublicKey) {
      return {
        success: false,
        sourcePublicKey,
        destinationPublicKey,
        reclaimedXLM: "0",
        error: "Source matches destination",
        skipped: true,
        skipReason: "Source matches destination",
      };
    }

    await job.updateProgress(30);

    try {
      const account = await server.loadAccount(sourcePublicKey);
      const evaluation = evaluateAccountMergeCandidate(
        {
          nativeBalance: getNativeBalance(account),
          subentryCount: account.subentry_count,
          hasNonNativeBalances: hasNonNativeBalances(account),
          lastActivityAt: await fetchLastActivityAt(server, sourcePublicKey),
        },
        inactivityDays,
      );

      await job.updateProgress(50);

      if (!evaluation.eligible) {
        return {
          success: false,
          sourcePublicKey,
          destinationPublicKey,
          reclaimedXLM: "0",
          error: evaluation.reason,
          skipped: true,
          skipReason: evaluation.reason,
        };
      }

      if (dryRun) {
        return {
          success: true,
          sourcePublicKey,
          destinationPublicKey,
          reclaimedXLM: evaluation.reclaimableBalance,
          skipped: true,
          skipReason: "Dry run mode",
        };
      }

      await job.updateProgress(70);

      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
      })
        .addOperation(
          StellarSdk.Operation.accountMerge({
            destination: destinationPublicKey,
          }),
        )
        .setTimeout(60)
        .build();

      transaction.sign(sourceKeypair);

      await job.updateProgress(90);

      const response = await server.submitTransaction(transaction);

      await job.updateProgress(100);

      console.log(
        `${ACCOUNT_MERGE_PREFIX} Merged ${sourcePublicKey} into ${destinationPublicKey}; reclaimed ${evaluation.reclaimableBalance} XLM; tx=${response.hash}`,
      );

      return {
        success: true,
        sourcePublicKey,
        destinationPublicKey,
        reclaimedXLM: evaluation.reclaimableBalance,
        transactionHash: response.hash,
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return {
          success: false,
          sourcePublicKey,
          destinationPublicKey,
          reclaimedXLM: "0",
          error: "Account not found on Horizon",
          skipped: true,
          skipReason: "Account not found",
        };
      }

      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error(
        `${ACCOUNT_MERGE_PREFIX} Failed to merge ${sourcePublicKey}:`,
        error,
      );

      throw error; // Let BullMQ retry
    }
  },
  workerOptions,
);

accountMergeWorker.on("completed", (job) => {
  const result = job.returnvalue;
  if (result?.skipped) {
    console.log(
      `${ACCOUNT_MERGE_PREFIX} Job ${job.id} skipped: ${result.skipReason}`,
    );
  } else if (result?.success) {
    console.log(
      `${ACCOUNT_MERGE_PREFIX} Job ${job.id} completed: reclaimed ${result.reclaimedXLM} XLM`,
    );
  }
});

accountMergeWorker.on("failed", (job, error) => {
  logger.error(
    `${ACCOUNT_MERGE_PREFIX} Job ${job?.id} failed after ${job?.attemptsMade} attempts:`,
    error.message,
  );

  if (job) {
    capturePersistentFailure(job).catch((err) =>
      logger.error("[DLQ] Error capturing failure:", err),
    );
  }
});

export async function closeAccountMergeWorker() {
  await accountMergeWorker.close();
}
