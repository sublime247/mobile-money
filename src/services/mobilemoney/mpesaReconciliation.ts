import { Readable } from "stream";
import csvParser from "csv-parser";
import { queryRead } from "../../config/database";
import {
  ReconciliationModel,
  ReconciliationStatus,
  DiscrepancyType,
} from "../../models/reconciliation";
import logger from "../../utils/logger";

export interface MpesaStatementRecord {
  receiptNo: string;
  completionTime: string;
  details: string;
  status: string;
  amount: string;
  balance?: string;
  conversationId: string;
  originatorConversationId?: string;
  recipientPhone?: string;
  [key: string]: string | undefined;
}

export interface MpesaReconciliationDiscrepancy {
  type: DiscrepancyType | "missing_callback" | "duplicate_disbursement";
  conversationId: string;
  receiptNo?: string;
  transactionId?: string;
  expectedValue: string;
  actualValue: string;
  details: string;
}

export interface MpesaReconciliationSummary {
  matchRate: string;
  totalStatementRecords: number;
  totalDbRecords: number;
  totalMatched: number;
  totalDiscrepancies: number;
  amountDiscrepancies: number;
  missingCallbacks: number;
  duplicateDisbursements: number;
  orphanedProvider: number;
  orphanedDb: number;
}

export interface MpesaReconciliationResult {
  reportId?: string;
  summary: MpesaReconciliationSummary;
  matched: Array<{
    conversationId: string;
    transactionId: string;
    amount: string;
    status: string;
  }>;
  discrepancies: MpesaReconciliationDiscrepancy[];
}

/**
 * Normalizes amount string (strips currency, spaces, commas, negative signs for withdrawals).
 */
export function normalizeAmount(amountStr?: string | number): string {
  if (amountStr === undefined || amountStr === null) return "0.00";
  const cleaned = String(amountStr).replace(/[^0-9.]/g, "").trim();
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? "0.00" : num.toFixed(2);
}

/**
 * Parses M-Pesa CSV statement export.
 */
export async function parseMpesaStatement(
  bufferOrString: Buffer | string,
): Promise<MpesaStatementRecord[]> {
  const buffer = Buffer.isBuffer(bufferOrString)
    ? bufferOrString
    : Buffer.from(bufferOrString, "utf8");

  return new Promise((resolve, reject) => {
    const results: MpesaStatementRecord[] = [];
    const stream = Readable.from(buffer);

    stream
      .pipe(
        csvParser({
          mapHeaders: ({ header }) => header.trim(),
        }),
      )
      .on("data", (row: Record<string, string>) => {
        // Map common M-Pesa header variants
        const receiptNo =
          row["Receipt No."] ||
          row["Transaction ID"] ||
          row["Receipt Number"] ||
          row["receipt_no"] ||
          row["ReceiptNo"] ||
          "";

        const completionTime =
          row["Completion Time"] ||
          row["Transaction Time"] ||
          row["completion_time"] ||
          row["Time"] ||
          "";

        const details =
          row["Details"] ||
          row["Transaction Details"] ||
          row["Transaction Type"] ||
          row["details"] ||
          "";

        const status =
          row["Transaction Status"] ||
          row["Status"] ||
          row["status"] ||
          "Completed";

        const amountRaw =
          row["Withdrawn"] ||
          row["Amount"] ||
          row["Paid In"] ||
          row["amount"] ||
          "0";

        const conversationId =
          row["ConversationID"] ||
          row["Conversation ID"] ||
          row["conversation_id"] ||
          row["OriginatorConversationID"] ||
          receiptNo;

        const originatorConversationId =
          row["OriginatorConversationID"] ||
          row["Originator Conversation ID"] ||
          row["originator_conversation_id"];

        const recipientPhone =
          row["Other Party Info"] ||
          row["Phone Number"] ||
          row["Recipient"] ||
          row["phone_number"];

        if (conversationId || receiptNo) {
          results.push({
            receiptNo: receiptNo.trim(),
            completionTime: completionTime.trim(),
            details: details.trim(),
            status: status.trim(),
            amount: normalizeAmount(amountRaw),
            balance: row["Balance"] ? normalizeAmount(row["Balance"]) : undefined,
            conversationId: conversationId.trim(),
            originatorConversationId: originatorConversationId?.trim(),
            recipientPhone: recipientPhone?.trim(),
          });
        }
      })
      .on("end", () => resolve(results))
      .on("error", (err) => reject(err));
  });
}

export class MpesaReconciliationService {
  private reconModel: ReconciliationModel;

  constructor() {
    this.reconModel = new ReconciliationModel();
  }

  /**
   * Reconciles M-Pesa B2C statement against internal transactions.
   */
  public async reconcile(options: {
    statementRecords: MpesaStatementRecord[];
    dateRange?: { start?: string; end?: string };
    reportDate?: Date;
    fileName?: string;
    persistToDb?: boolean;
  }): Promise<MpesaReconciliationResult> {
    const {
      statementRecords,
      dateRange,
      reportDate = new Date(),
      fileName = `mpesa_b2c_${reportDate.toISOString().split("T")[0]}.csv`,
      persistToDb = true,
    } = options;

    logger.info(
      { count: statementRecords.length, date: reportDate.toISOString() },
      "[MpesaReconciliation] Starting M-Pesa B2C daily reconciliation",
    );

    // 1. Fetch internal M-Pesa transactions from database
    let query = `
      SELECT 
        id, 
        reference_number,
        provider_reference,
        amount::text as amount, 
        status, 
        phone_number, 
        provider, 
        created_at::text as created_at
      FROM transactions
      WHERE (LOWER(provider) = 'mpesa' OR LOWER(provider) = 'safaricom')
    `;
    const params: string[] = [];

    if (dateRange?.start) {
      params.push(dateRange.start);
      query += ` AND created_at >= $${params.length}`;
    }
    if (dateRange?.end) {
      params.push(dateRange.end);
      query += ` AND created_at <= $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    let dbRecords: Array<{
      id: string;
      reference_number: string;
      provider_reference: string | null;
      amount: string;
      status: string;
      phone_number: string;
      provider: string;
      created_at: string;
    }> = [];

    try {
      const res = await queryRead<any>(query, params);
      dbRecords = res.rows;
    } catch (err: any) {
      logger.warn(
        { err: err.message },
        "[MpesaReconciliation] Failed to query transactions from DB, falling back to empty list",
      );
    }

    // Index DB records by providerReference (conversationId) and reference_number
    const dbByConversationId = new Map<string, typeof dbRecords[0]>();
    const dbSeenConversations = new Set<string>();
    const dbDuplicateConversations = new Set<string>();

    for (const r of dbRecords) {
      const key = r.provider_reference || r.reference_number;
      if (key) {
        if (dbSeenConversations.has(key)) {
          dbDuplicateConversations.add(key);
        }
        dbSeenConversations.add(key);
        dbByConversationId.set(key, r);
      }
    }

    // Check duplicate disbursements in statement
    const statementCounts = new Map<string, number>();
    for (const s of statementRecords) {
      const count = statementCounts.get(s.conversationId) ?? 0;
      statementCounts.set(s.conversationId, count + 1);
    }

    const matched: MpesaReconciliationResult["matched"] = [];
    const discrepancies: MpesaReconciliationDiscrepancy[] = [];
    const matchedStatementKeys = new Set<string>();
    const matchedDbKeys = new Set<string>();

    let amountDiscrepancies = 0;
    let missingCallbacks = 0;
    let duplicateDisbursements = 0;

    for (const statement of statementRecords) {
      const convId = statement.conversationId;
      const isDuplicateInStatement = (statementCounts.get(convId) ?? 0) > 1;

      matchedStatementKeys.add(convId);

      const dbRecord =
        dbByConversationId.get(convId) ||
        (statement.originatorConversationId
          ? dbByConversationId.get(statement.originatorConversationId)
          : undefined);

      if (!dbRecord) {
        // Orphaned Provider record
        discrepancies.push({
          type: DiscrepancyType.OrphanedProvider,
          conversationId: convId,
          receiptNo: statement.receiptNo,
          expectedValue: "Transaction present in DB",
          actualValue: `Statement row exists: amount ${statement.amount}, status ${statement.status}`,
          details: `Disbursement in M-Pesa statement with conversation_id ${convId} has no internal transaction record`,
        });
        continue;
      }

      const dbKey = dbRecord.provider_reference || dbRecord.reference_number;
      if (dbKey) matchedDbKeys.add(dbKey);

      if (isDuplicateInStatement) {
        duplicateDisbursements++;
        discrepancies.push({
          type: "duplicate_disbursement",
          conversationId: convId,
          receiptNo: statement.receiptNo,
          expectedValue: "Single disbursement",
          actualValue: `Duplicate disbursement in statement (${statementCounts.get(convId)} occurrences)`,
          details: `Conversation ID ${convId} appears multiple times in M-Pesa statement`,
        });
        continue;
      }

      const dbNormAmount = normalizeAmount(dbRecord.amount);
      const stmtNormAmount = normalizeAmount(statement.amount);

      // Check amount discrepancy
      if (dbNormAmount !== stmtNormAmount) {
        amountDiscrepancies++;
        discrepancies.push({
          type: DiscrepancyType.AmountMismatch,
          conversationId: convId,
          receiptNo: statement.receiptNo,
          transactionId: dbRecord.id,
          expectedValue: `Amount: ${dbNormAmount}`,
          actualValue: `Amount: ${stmtNormAmount}`,
          details: `Amount mismatch for conversation_id ${convId}: DB has ${dbNormAmount}, statement has ${stmtNormAmount}`,
        });
        continue;
      }

      // Check missing callback: Statement is successful/completed, but DB is still pending
      const isStatementSuccess =
        statement.status.toLowerCase() === "completed" ||
        statement.status.toLowerCase() === "success";

      if (isStatementSuccess && dbRecord.status.toLowerCase() === "pending") {
        missingCallbacks++;
        discrepancies.push({
          type: "missing_callback",
          conversationId: convId,
          receiptNo: statement.receiptNo,
          transactionId: dbRecord.id,
          expectedValue: "Status: completed",
          actualValue: "Status: pending (callback missing)",
          details: `M-Pesa disbursement completed on-chain/network but internal transaction ${dbRecord.id} is still pending (callback not received)`,
        });
        continue;
      }

      // Check duplicate disbursements in DB
      if (dbKey && dbDuplicateConversations.has(dbKey)) {
        duplicateDisbursements++;
        discrepancies.push({
          type: "duplicate_disbursement",
          conversationId: convId,
          transactionId: dbRecord.id,
          expectedValue: "Single internal transaction",
          actualValue: "Multiple transactions share this provider reference",
          details: `Duplicate disbursement records found in DB for conversation_id ${convId}`,
        });
        continue;
      }

      matched.push({
        conversationId: convId,
        transactionId: dbRecord.id,
        amount: dbNormAmount,
        status: dbRecord.status,
      });
    }

    // Identify orphaned DB records (B2C disbursements created internally but missing in statement)
    let orphanedDb = 0;
    for (const dbRecord of dbRecords) {
      const key = dbRecord.provider_reference || dbRecord.reference_number;
      if (key && !matchedDbKeys.has(key)) {
        orphanedDb++;
        discrepancies.push({
          type: DiscrepancyType.OrphanedDb,
          conversationId: key,
          transactionId: dbRecord.id,
          expectedValue: `Record in M-Pesa statement for ${key}`,
          actualValue: "Missing in M-Pesa statement",
          details: `Internal disbursement transaction ${dbRecord.id} does not appear in M-Pesa statement`,
        });
      }
    }

    const orphanedProvider = statementRecords.filter(
      (s) => !matchedStatementKeys.has(s.conversationId),
    ).length;

    const totalStatementRecords = statementRecords.length;
    const totalDbRecords = dbRecords.length;
    const totalMatched = matched.length;
    const totalDiscrepancies = discrepancies.length;
    const matchRate =
      totalStatementRecords > 0
        ? `${((totalMatched / totalStatementRecords) * 100).toFixed(2)}%`
        : "0.00%";

    const summary: MpesaReconciliationSummary = {
      matchRate,
      totalStatementRecords,
      totalDbRecords,
      totalMatched,
      totalDiscrepancies,
      amountDiscrepancies,
      missingCallbacks,
      duplicateDisbursements,
      orphanedProvider,
      orphanedDb,
    };

    let reportId: string | undefined;

    // 2. Persist audit status and report in database if requested
    if (persistToDb) {
      try {
        const report = await this.reconModel.createReport({
          provider: "MPESA_B2C",
          reportDate,
          fileName,
          status:
            totalDiscrepancies === 0
              ? ReconciliationStatus.Completed
              : ReconciliationStatus.Failed,
          summary: summary as unknown as Record<string, unknown>,
        });
        reportId = report.id;

        for (const disc of discrepancies) {
          const discType =
            disc.type === "missing_callback"
              ? DiscrepancyType.StatusMismatch
              : disc.type === "duplicate_disbursement"
                ? DiscrepancyType.AmountMismatch
                : disc.type;

          await this.reconModel.createDiscrepancy({
            reportId: report.id,
            transactionId: disc.transactionId,
            referenceNumber: disc.conversationId,
            type: discType,
            expectedValue: disc.expectedValue,
            actualValue: disc.actualValue,
          });
        }

        await this.reconModel.updateReport(report.id, {
          status: ReconciliationStatus.Completed,
          summary: summary as unknown as Record<string, unknown>,
        });

        logger.info(
          { reportId, matchRate, totalDiscrepancies },
          "[MpesaReconciliation] Stored daily reconciliation report in database",
        );
      } catch (err: any) {
        logger.error(
          { err: err.message },
          "[MpesaReconciliation] Failed to persist reconciliation report to database",
        );
      }
    }

    return {
      reportId,
      summary,
      matched,
      discrepancies,
    };
  }
}

export const mpesaReconciliationService = new MpesaReconciliationService();
