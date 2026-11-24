import { queryRead } from "../config/database";
import { getStellarServer } from "../config/stellar";
import { lookupHorizonTransaction } from "../workers/stellarReconciliation";
import logger from "../utils/logger";

export interface ReconciliationDiscrepancy {
  id: string;
  referenceNumber: string;
  type: "horizon_mismatch" | "telco_mismatch" | "amount_mismatch" | "status_mismatch";
  description: string;
  internalAmount: number;
  externalAmount?: number;
  internalStatus: string;
  externalStatus?: string;
}

export interface ReconciliationReportSummary {
  startDate: string;
  endDate: string;
  totalVolume: number;
  totalCount: number;
  matchedCount: number;
  discrepancyCount: number;
  discrepancies: ReconciliationDiscrepancy[];
}

export interface ReconciliationOptions {
  date?: string;
  startDate?: string;
  endDate?: string;
  pool?: any;
  horizonServer?: any;
}

/**
 * Validates a YYYY-MM-DD date string.
 */
export function isValidDateString(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

/**
 * Runs on-demand reconciliation comparing internal transactions
 * against Horizon payments and telco records for a given date or date range.
 */
export async function runOnDemandReconciliation(
  options: ReconciliationOptions,
): Promise<ReconciliationReportSummary> {
  let start: Date;
  let end: Date;

  if (options.date) {
    if (!isValidDateString(options.date)) {
      throw new Error(`Invalid date format: ${options.date}. Expected YYYY-MM-DD.`);
    }
    start = new Date(`${options.date}T00:00:00.000Z`);
    end = new Date(`${options.date}T23:59:59.999Z`);
  } else if (options.startDate && options.endDate) {
    if (!isValidDateString(options.startDate)) {
      throw new Error(`Invalid start date format: ${options.startDate}. Expected YYYY-MM-DD.`);
    }
    if (!isValidDateString(options.endDate)) {
      throw new Error(`Invalid end date format: ${options.endDate}. Expected YYYY-MM-DD.`);
    }
    start = new Date(`${options.startDate}T00:00:00.000Z`);
    end = new Date(`${options.endDate}T23:59:59.999Z`);
  } else {
    // Default to today
    const today = new Date().toISOString().split("T")[0];
    start = new Date(`${today}T00:00:00.000Z`);
    end = new Date(`${today}T23:59:59.999Z`);
  }

  if (start.getTime() > end.getTime()) {
    throw new Error("Start date must be earlier than or equal to end date.");
  }

  logger.info(
    `[accountingReconciliation] Starting reconciliation from ${start.toISOString()} to ${end.toISOString()}`,
  );

  let transactions: any[] = [];
  try {
    const queryFn = options.pool?.query ? options.pool.query.bind(options.pool) : queryRead;
    const res = await queryFn(
      `SELECT id, reference_number, type, amount, status, provider, stellar_transaction_hash,
              created_at, metadata
         FROM transactions
        WHERE created_at >= $1 AND created_at <= $2
        ORDER BY created_at ASC`,
      [start.toISOString(), end.toISOString()],
    );
    transactions = res?.rows || [];
  } catch (err) {
    logger.warn(`[accountingReconciliation] DB query failed or unconfigured, falling back: ${err}`);
    transactions = [];
  }

  let totalVolume = 0;
  let matchedCount = 0;
  const discrepancies: ReconciliationDiscrepancy[] = [];

  const horizon = options.horizonServer || getStellarServer();

  for (const tx of transactions) {
    const amountNum = parseFloat(tx.amount || "0") || 0;
    totalVolume += amountNum;

    let hasDiscrepancy = false;

    // 1. Verify against Horizon payment if stellar transaction hash is recorded
    if (tx.stellar_transaction_hash) {
      try {
        const horizonRes = await lookupHorizonTransaction(horizon, tx.stellar_transaction_hash);
        if (horizonRes.notFound) {
          discrepancies.push({
            id: tx.id,
            referenceNumber: tx.reference_number || tx.id,
            type: "horizon_mismatch",
            description: `Stellar transaction ${tx.stellar_transaction_hash} not found on Horizon`,
            internalAmount: amountNum,
            internalStatus: tx.status,
          });
          hasDiscrepancy = true;
        } else if (tx.status === "completed" && horizonRes.successful === false) {
          discrepancies.push({
            id: tx.id,
            referenceNumber: tx.reference_number || tx.id,
            type: "status_mismatch",
            description: `Internal transaction is completed but Horizon reported failure`,
            internalAmount: amountNum,
            internalStatus: tx.status,
            externalStatus: "failed",
          });
          hasDiscrepancy = true;
        }
      } catch (hErr) {
        logger.warn(`Horizon lookup error for tx ${tx.id}: ${hErr}`);
      }
    }

    // 2. Verify against Telco records from metadata if available
    if (tx.metadata && typeof tx.metadata === "object") {
      const telcoStatus = tx.metadata.provider_status || tx.metadata.telco_status;
      const telcoAmount = tx.metadata.provider_amount || tx.metadata.telco_amount;

      if (telcoAmount !== undefined && parseFloat(telcoAmount) !== amountNum) {
        discrepancies.push({
          id: tx.id,
          referenceNumber: tx.reference_number || tx.id,
          type: "amount_mismatch",
          description: `Internal amount ${amountNum} differs from Telco amount ${telcoAmount}`,
          internalAmount: amountNum,
          externalAmount: parseFloat(telcoAmount),
          internalStatus: tx.status,
          externalStatus: telcoStatus,
        });
        hasDiscrepancy = true;
      } else if (
        telcoStatus &&
        tx.status === "completed" &&
        telcoStatus !== "completed" &&
        telcoStatus !== "SUCCESSFUL" &&
        telcoStatus !== "SUCCESS"
      ) {
        discrepancies.push({
          id: tx.id,
          referenceNumber: tx.reference_number || tx.id,
          type: "telco_mismatch",
          description: `Internal status '${tx.status}' does not match Telco status '${telcoStatus}'`,
          internalAmount: amountNum,
          internalStatus: tx.status,
          externalStatus: telcoStatus,
        });
        hasDiscrepancy = true;
      }
    }

    if (!hasDiscrepancy) {
      matchedCount++;
    }
  }

  const discrepancyCount = discrepancies.length;

  return {
    startDate: start.toISOString().split("T")[0],
    endDate: end.toISOString().split("T")[0],
    totalVolume: Math.round(totalVolume * 100) / 100,
    totalCount: transactions.length,
    matchedCount,
    discrepancyCount,
    discrepancies,
  };
}

export class AccountingReconciliationService {
  async runOnDemand(options: ReconciliationOptions): Promise<ReconciliationReportSummary> {
    return runOnDemandReconciliation(options);
  }
}

export default AccountingReconciliationService;

