import { pool } from "../config/database";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { TransactionModel, TransactionStatus } from "../models/transaction";

/**
 * Status Check Job
 * Schedule: Every hour (0 * * * *)
 * Resolves transactions stuck in 'pending' longer than STALE_TRANSACTION_HOURS (default: 12).
 */

const mobileMoneyService = new MobileMoneyService();
const transactionModel = new TransactionModel();

const COMPLETED_PROVIDER_STATUSES = new Set([
  "SUCCESS",
  "SUCCESSFUL",
  "COMPLETED",
  "DONE",
  "PAID",
]);

const FAILED_PROVIDER_STATUSES = new Set([
  "FAILED",
  "ERROR",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "TIMEOUT",
]);

function extractStatusValue(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const root = payload as Record<string, unknown>;
  const direct = root.status;
  if (typeof direct === "string" && direct.trim()) {
    return direct.toUpperCase();
  }

  const data = root.data;
  if (data && typeof data === "object") {
    const nestedStatus = (data as Record<string, unknown>).status;
    if (typeof nestedStatus === "string" && nestedStatus.trim()) {
      return nestedStatus.toUpperCase();
    }

    const nestedTransaction = (data as Record<string, unknown>).transaction;
    if (nestedTransaction && typeof nestedTransaction === "object") {
      const transactionStatus = (nestedTransaction as Record<string, unknown>)
        .status;
      if (typeof transactionStatus === "string" && transactionStatus.trim()) {
        return transactionStatus.toUpperCase();
      }
    }
  }

  const transaction = root.transaction;
  if (transaction && typeof transaction === "object") {
    const transactionStatus = (transaction as Record<string, unknown>).status;
    if (typeof transactionStatus === "string" && transactionStatus.trim()) {
      return transactionStatus.toUpperCase();
    }
  }

  return null;
}

async function failAsExpired(
  id: string,
  provider: string,
  referenceNumber: string,
  detail: string,
): Promise<void> {
  await transactionModel.updateStatus(id, TransactionStatus.Failed);
  await transactionModel.patchMetadata(id, {
    watchdog: {
      reason: "EXPIRED",
      checkedAt: new Date().toISOString(),
      provider,
      referenceNumber,
      detail,
    },
  });

  console.warn(
    `[status-check] Marked transaction as EXPIRED id=${id} ref=${referenceNumber} provider=${provider} detail=${detail}`,
  );
}

export async function runStatusCheckJob(): Promise<void> {
  const staleHours = parseInt(
    process.env.STALE_TRANSACTION_HOURS ||
      process.env.STUCK_TRANSACTION_HOURS ||
      "12",
    10,
  );

  const result = await pool.query(
    `SELECT id, reference_number, provider, created_at
     FROM transactions
     WHERE status = 'pending'
       AND created_at < NOW() - ($1::int * INTERVAL '1 hour')`,
    [staleHours],
  );

  if (result.rows.length === 0) {
    console.log("[status-check] No stale pending transactions found");
    return;
  }

  console.warn(
    `[status-check] Found ${result.rows.length} stale pending transaction(s); validating with providers`,
  );

  for (const row of result.rows) {
    const id = String(row.id);
    const provider = String(row.provider ?? "").toLowerCase();
    const referenceNumber = String(row.reference_number);

    try {
      const providerStatus = await mobileMoneyService.getTransactionStatus(
        provider,
        referenceNumber,
      );

      if (!providerStatus.success) {
        await failAsExpired(
          id,
          provider,
          referenceNumber,
          "Provider status check failed",
        );
        continue;
      }

      const normalizedStatus = extractStatusValue(providerStatus.data);
      if (normalizedStatus && COMPLETED_PROVIDER_STATUSES.has(normalizedStatus)) {
        await transactionModel.updateStatus(id, TransactionStatus.Completed);
        await transactionModel.patchMetadata(id, {
          watchdog: {
            checkedAt: new Date().toISOString(),
            provider,
            referenceNumber,
            providerStatus: normalizedStatus,
            resolvedBy: "stale-transaction-watchdog",
          },
        });
        console.log(
          `[status-check] Finalized as completed id=${id} ref=${referenceNumber} providerStatus=${normalizedStatus}`,
        );
        continue;
      }

      if (normalizedStatus && FAILED_PROVIDER_STATUSES.has(normalizedStatus)) {
        await transactionModel.updateStatus(id, TransactionStatus.Failed);
        await transactionModel.patchMetadata(id, {
          watchdog: {
            checkedAt: new Date().toISOString(),
            provider,
            referenceNumber,
            providerStatus: normalizedStatus,
            resolvedBy: "stale-transaction-watchdog",
          },
        });
        console.warn(
          `[status-check] Finalized as failed id=${id} ref=${referenceNumber} providerStatus=${normalizedStatus}`,
        );
        continue;
      }

      await failAsExpired(
        id,
        provider,
        referenceNumber,
        normalizedStatus
          ? `Provider still pending (${normalizedStatus}) past stale threshold`
          : "Unknown provider status payload",
      );
    } catch (error) {
      await failAsExpired(
        id,
        provider,
        referenceNumber,
        error instanceof Error ? error.message : "Unhandled status-check error",
      );
    }
  }
}
