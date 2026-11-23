import { getStellarServer } from "../config/stellar";
import { pool } from "../config/database";
import { TransactionModel } from "../models/transaction";
import logger from "../utils/logger";
import {
  createFeeBumpForPendingTransaction,
  PendingFeeBumpResult,
  SubmitTransactionResult,
  submitTransaction,
} from "./transactions";

export const DEFAULT_PENDING_TRANSACTION_AGE_MS = 60_000;
export const DEFAULT_MAX_FEE_BUMPS = 3;
export const DEFAULT_LEDGER_CLOSE_TIME_MS = 5_000;

export interface PendingStellarTransaction {
  id: string;
  hash: string;
  envelope: string;
  submittedAt: string | number;
  feeBumps?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface FeeBumpWatchdogOptions {
  ageThresholdMs?: number;
  ledgerCloseTimeMs?: number;
  maxFeeBumps?: number;
  now?: () => number;
  loadPending?: () => Promise<PendingStellarTransaction[]>;
  getLedgerClosedAt?: () => Promise<number>;
  isConfirmed?: (hash: string) => Promise<boolean>;
  bumpFee?: (envelope: string) => PendingFeeBumpResult;
  submit?: (envelope: string) => Promise<SubmitTransactionResult>;
  onBumped?: (
    record: PendingStellarTransaction,
    bump: PendingFeeBumpResult,
    result: SubmitTransactionResult,
  ) => Promise<void>;
}

export interface FeeBumpWatchdogResult {
  inspected: number;
  bumped: number;
  confirmed: number;
  skipped: number;
  failed: number;
}

export async function loadPendingStellarTransactions(): Promise<
  PendingStellarTransaction[]
> {
  const result = await pool.query(
    `SELECT id, metadata
     FROM transactions
     WHERE status = 'pending'
       AND provider = 'stellar'
       AND metadata->'stellar'->>'transactionHash' IS NOT NULL
       AND metadata->'stellar'->>'envelope' IS NOT NULL
     LIMIT 50`,
  );

  return result.rows
    .map((row: { id: string; metadata?: Record<string, any> }) => {
      const stellar = row.metadata?.stellar ?? {};
      if (
        typeof stellar.transactionHash !== "string" ||
        typeof stellar.envelope !== "string" ||
        !stellar.submittedAt
      ) {
        return null;
      }

      return {
        id: row.id,
        hash: stellar.transactionHash,
        envelope: stellar.envelope,
        submittedAt: stellar.submittedAt,
        feeBumps: Array.isArray(stellar.feeBumps) ? stellar.feeBumps : [],
        metadata: row.metadata ?? {},
      };
    })
    .filter(
      (
        record: PendingStellarTransaction | null,
      ): record is PendingStellarTransaction => record !== null,
    );
}

export async function getLatestLedgerClosedAt(): Promise<number> {
  const response = await getStellarServer()
    .ledgers()
    .order("desc")
    .limit(1)
    .call();
  const closedAt = Date.parse(response.records[0]?.closed_at ?? "");
  return Number.isFinite(closedAt) ? closedAt : Date.now();
}

export async function isTransactionConfirmed(hash: string): Promise<boolean> {
  try {
    await getStellarServer().transactions().transaction(hash).call();
    return true;
  } catch (error: any) {
    if (error?.response?.status === 404) return false;
    logger.warn(
      { transaction_hash: hash, err: error?.message ?? String(error) },
      "Could not verify Stellar transaction confirmation",
    );
    return false;
  }
}

export async function persistFeeBump(
  record: PendingStellarTransaction,
  bump: PendingFeeBumpResult,
  result: SubmitTransactionResult,
): Promise<void> {
  const metadata = record.metadata ?? {};
  const stellar = (metadata.stellar ?? {}) as Record<string, unknown>;
  const previousBumps = Array.isArray(stellar.feeBumps) ? stellar.feeBumps : [];

  await new TransactionModel().updateMetadata(record.id, {
    ...metadata,
    stellar: {
      ...stellar,
      transactionHash: result.transactionHash ?? bump.feeBumpTransactionHash,
      envelope: bump.envelope,
      submittedAt: new Date().toISOString(),
      originalFee: bump.originalFee,
      fee: bump.fee,
      feeBumps: [
        ...previousBumps,
        {
          previousHash: record.hash,
          newHash: result.transactionHash ?? bump.feeBumpTransactionHash,
          fee: bump.fee,
          bumpedAt: new Date().toISOString(),
        },
      ],
    },
  });
}

export async function runFeeBumpWatchdogOnce(
  options: FeeBumpWatchdogOptions = {},
): Promise<FeeBumpWatchdogResult> {
  const now = options.now ?? Date.now;
  const ageThresholdMs =
    options.ageThresholdMs ?? DEFAULT_PENDING_TRANSACTION_AGE_MS;
  const maxFeeBumps = options.maxFeeBumps ?? DEFAULT_MAX_FEE_BUMPS;
  const loadPending = options.loadPending ?? loadPendingStellarTransactions;
  const getLedgerClosedAt =
    options.getLedgerClosedAt ?? getLatestLedgerClosedAt;
  const isConfirmed = options.isConfirmed ?? isTransactionConfirmed;
  const bumpFee = options.bumpFee ?? createFeeBumpForPendingTransaction;
  const submit = options.submit ?? submitTransaction;
  const onBumped = options.onBumped ?? persistFeeBump;

  const result: FeeBumpWatchdogResult = {
    inspected: 0,
    bumped: 0,
    confirmed: 0,
    skipped: 0,
    failed: 0,
  };

  let pending: PendingStellarTransaction[];
  let ledgerClosedAt: number;
  try {
    [pending, ledgerClosedAt] = await Promise.all([
      loadPending(),
      getLedgerClosedAt(),
    ]);
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "Fee bump watchdog could not load pending transactions",
    );
    return result;
  }

  const referenceTime = Math.min(now(), ledgerClosedAt);
  for (const record of pending) {
    result.inspected += 1;

    const submittedAt = new Date(record.submittedAt).getTime();
    if (
      !Number.isFinite(submittedAt) ||
      referenceTime - submittedAt < ageThresholdMs
    ) {
      result.skipped += 1;
      continue;
    }

    if ((record.feeBumps?.length ?? 0) >= maxFeeBumps) {
      logger.warn(
        { transaction_id: record.id, transaction_hash: record.hash },
        "Pending transaction reached the maximum number of fee bumps",
      );
      result.skipped += 1;
      continue;
    }

    try {
      if (await isConfirmed(record.hash)) {
        result.confirmed += 1;
        continue;
      }

      const bump = bumpFee(record.envelope);
      const submission = await submit(bump.envelope);
      if (!submission.success) {
        throw new Error(submission.error ?? "Fee bump submission failed");
      }

      await onBumped(record, bump, submission);
      result.bumped += 1;
      logger.info(
        {
          transaction_id: record.id,
          transaction_hash: record.hash,
          fee_bump_hash: submission.transactionHash,
          original_fee: bump.originalFee,
          fee: bump.fee,
        },
        "Fee bumped Stellar transaction stuck in mempool",
      );
    } catch (error) {
      result.failed += 1;
      logger.error(
        {
          transaction_id: record.id,
          transaction_hash: record.hash,
          err: error instanceof Error ? error.message : String(error),
        },
        "Fee bump watchdog failed for pending transaction",
      );
    }
  }

  return result;
}

export default runFeeBumpWatchdogOnce;
