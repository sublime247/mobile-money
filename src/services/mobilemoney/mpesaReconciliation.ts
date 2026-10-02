/**
 * M-Pesa B2C Automated Daily Reconciliation Service
 * Resolves Issue #2129: Reconciles Safaricom M-Pesa daily B2C statement exports
 * against internal disbursement records to detect financial discrepancies.
 */

export interface MpesaStatementRecord {
  receiptNo: string;
  completionTime: string;
  conversationId: string;
  details: string;
  status: "Completed" | "Failed" | "Reversed";
  paidIn: number;
  withdrawn: number;
  balance: number;
}

export interface InternalDisbursementRecord {
  id: string;
  conversationId: string;
  mpesaReceiptNo?: string;
  amount: number;
  currency: string;
  status: "pending" | "completed" | "failed";
  createdAt: string;
}

export enum DiscrepancyType {
  AMOUNT_MISMATCH = "AMOUNT_MISMATCH",
  STATUS_MISMATCH = "STATUS_MISMATCH",
  MISSING_IN_INTERNAL = "MISSING_IN_INTERNAL",
  MISSING_IN_PROVIDER = "MISSING_IN_PROVIDER",
  DUPLICATE_DISBURSEMENT = "DUPLICATE_DISBURSEMENT",
}

export interface DiscrepancyItem {
  type: DiscrepancyType;
  conversationId: string;
  mpesaReceiptNo?: string;
  internalAmount?: number;
  statementAmount?: number;
  description: string;
}

export interface ReconciliationSummary {
  reportDate: string;
  totalStatementRecords: number;
  totalInternalRecords: number;
  matchedCount: number;
  matchedVolume: number;
  discrepancies: DiscrepancyItem[];
  status: "RECONCILED" | "ACTION_REQUIRED";
}

/**
 * Pure reconciliation engine used by the reconciliation service.
 */
export class MpesaReconciliationEngine {
  static parseStatementCsv(csvContent: string): MpesaStatementRecord[] {
    const lines = csvContent.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    const header = lines[0].split(",").map((h) => h.trim());
    const records: MpesaStatementRecord[] = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",").map((p) => p.trim());
      if (parts.length < header.length) continue;

      records.push({
        receiptNo: parts[0],
        completionTime: parts[1],
        conversationId: parts[2],
        details: parts[3],
        status: parts[4] as "Completed" | "Failed" | "Reversed",
        paidIn: parseFloat(parts[5]) || 0,
        withdrawn: parseFloat(parts[6]) || 0,
        balance: parseFloat(parts[7]) || 0,
      });
    }

    return records;
  }

  static reconcile(
    statementRecords: MpesaStatementRecord[],
    internalRecords: InternalDisbursementRecord[],
    reportDate: string,
  ): ReconciliationSummary {
    const internalByConvId = new Map<string, InternalDisbursementRecord[]>();
    for (const rec of internalRecords) {
      const list = internalByConvId.get(rec.conversationId) || [];
      list.push(rec);
      internalByConvId.set(rec.conversationId, list);
    }

    const discrepancies: DiscrepancyItem[] = [];
    let matchedCount = 0;
    let matchedVolume = 0;
    const matchedConvIds = new Set<string>();

    // 1. Process statement records
    for (const stmt of statementRecords) {
      const matches = internalByConvId.get(stmt.conversationId);

      if (!matches || matches.length === 0) {
        discrepancies.push({
          type: DiscrepancyType.MISSING_IN_INTERNAL,
          conversationId: stmt.conversationId,
          mpesaReceiptNo: stmt.receiptNo,
          statementAmount: stmt.withdrawn,
          description: `Transaction ${stmt.receiptNo} exists on statement but missing in internal database.`,
        });
        continue;
      }

      if (matches.length > 1) {
        discrepancies.push({
          type: DiscrepancyType.DUPLICATE_DISBURSEMENT,
          conversationId: stmt.conversationId,
          mpesaReceiptNo: stmt.receiptNo,
          description: `Multiple internal records found for conversationId ${stmt.conversationId}.`,
        });
        continue;
      }

      const internal = matches[0];
      matchedConvIds.add(stmt.conversationId);

      // Check amount
      if (Math.abs(internal.amount - stmt.withdrawn) > 0.001) {
        discrepancies.push({
          type: DiscrepancyType.AMOUNT_MISMATCH,
          conversationId: stmt.conversationId,
          mpesaReceiptNo: stmt.receiptNo,
          internalAmount: internal.amount,
          statementAmount: stmt.withdrawn,
          description: `Amount mismatch: internal=${internal.amount}, statement=${stmt.withdrawn}.`,
        });
      } else if (
        (stmt.status === "Completed" && internal.status !== "completed") ||
        (stmt.status !== "Completed" && internal.status === "completed")
      ) {
        discrepancies.push({
          type: DiscrepancyType.STATUS_MISMATCH,
          conversationId: stmt.conversationId,
          mpesaReceiptNo: stmt.receiptNo,
          description: `Status mismatch: internal=${internal.status}, statement=${stmt.status}.`,
        });
      } else {
        matchedCount++;
        matchedVolume += internal.amount;
      }
    }

    // 2. Check for internal records missing in statement
    for (const internal of internalRecords) {
      if (!matchedConvIds.has(internal.conversationId)) {
        discrepancies.push({
          type: DiscrepancyType.MISSING_IN_PROVIDER,
          conversationId: internal.conversationId,
          internalAmount: internal.amount,
          description: `Internal transaction ${internal.conversationId} not found in M-Pesa statement.`,
        });
      }
    }

    return {
      reportDate,
      totalStatementRecords: statementRecords.length,
      totalInternalRecords: internalRecords.length,
      matchedCount,
      matchedVolume: parseFloat(matchedVolume.toFixed(2)),
      discrepancies,
      status: discrepancies.length === 0 ? "RECONCILED" : "ACTION_REQUIRED",
    };
  }
}
