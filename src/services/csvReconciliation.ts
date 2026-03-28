import { Readable } from "stream";
import csvParser from "csv-parser";
import { queryRead } from "../config/database";

export interface ProviderCSVRow {
  reference_number?: string;
  reference_id?: string;
  amount?: string;
  status?: string;
  phone_number?: string;
  provider?: string;
  [key: string]: string | undefined;
}

export interface ReconciliationMatch {
  reference_number: string;
  amount: string;
  status: string;
  provider_status?: string;
  matched: boolean;
  db_record?: {
    id: string;
    reference_number: string;
    amount: string;
    status: string;
    phone_number: string;
    provider: string;
    created_at: string;
  };
  provider_record?: ProviderCSVRow;
}

export interface ReconciliationResult {
  total_provider_rows: number;
  total_db_records: number;
  matched: ReconciliationMatch[];
  discrepancies: ReconciliationMatch[];
  orphaned_provider: ProviderCSVRow[];
  orphaned_db: {
    id: string;
    reference_number: string;
    amount: string;
    status: string;
    phone_number: string;
    provider: string;
    created_at: string;
  }[];
  summary: {
    match_rate: string;
    total_matched: number;
    total_discrepancies: number;
    total_orphaned_provider: number;
    total_orphaned_db: number;
  };
}

/**
 * Parse CSV buffer into array of objects
 */
export async function parseCSV(buffer: Buffer): Promise<ProviderCSVRow[]> {
  return new Promise((resolve, reject) => {
    const results: ProviderCSVRow[] = [];
    const stream = Readable.from(buffer);

    stream
      .pipe(csvParser())
      .on("data", (data: ProviderCSVRow) => {
        // Trim all string values
        const trimmedData: ProviderCSVRow = {};
        for (const [key, value] of Object.entries(data)) {
          trimmedData[key] = typeof value === "string" ? value.trim() : value;
        }
        if (Object.keys(trimmedData).length > 0) {
          results.push(trimmedData);
        }
      })
      .on("end", () => resolve(results))
      .on("error", (error) => reject(error));
  });
}

/**
 * Normalize reference number (handle different formats)
 */
function normalizeReferenceNumber(ref?: string): string | null {
  if (!ref) return null;
  return ref.trim().toUpperCase();
}

/**
 * Normalize amount for comparison (remove currency symbols, commas)
 */
function normalizeAmount(amount?: string): string | null {
  if (!amount) return null;
  return amount.replace(/[^0-9.]/g, "").trim();
}

/**
 * Reconcile provider CSV against database transactions
 */
export async function reconcileTransactions(
  providerRows: ProviderCSVRow[],
  dateRange?: { start?: string; end?: string },
): Promise<ReconciliationResult> {
  // Build query to fetch relevant transactions from DB
  let query = `
    SELECT 
      id, 
      reference_number, 
      amount::text as amount, 
      status, 
      phone_number, 
      provider, 
      created_at::text as created_at
    FROM transactions
    WHERE 1=1
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

  const dbResult = await queryRead(query, params);
  const dbRecords = dbResult.rows;

  // Create lookup maps
  const dbByReference = new Map(
    dbRecords.map((r) => [normalizeReferenceNumber(r.reference_number), r]),
  );

  const providerByReference = new Map(
    providerRows.map((r) => [
      normalizeReferenceNumber(r.reference_number || r.reference_id),
      r,
    ]),
  );

  const matched: ReconciliationMatch[] = [];
  const discrepancies: ReconciliationMatch[] = [];
  const matchedDbRefs = new Set<string>();
  const matchedProviderRefs = new Set<string>();

  // Match by reference number
  for (const [refNum, providerRow] of providerByReference.entries()) {
    if (!refNum) continue;

    const dbRecord = dbByReference.get(refNum);

    if (dbRecord) {
      matchedDbRefs.add(refNum);
      matchedProviderRefs.add(refNum);

      const dbAmount = normalizeAmount(dbRecord.amount);
      const providerAmount = normalizeAmount(providerRow.amount);

      const amountMatch = dbAmount === providerAmount;
      const statusMatch =
        dbRecord.status.toLowerCase() ===
        (providerRow.status || "").toLowerCase();

      const reconciliationMatch: ReconciliationMatch = {
        reference_number: dbRecord.reference_number,
        amount: dbRecord.amount,
        status: dbRecord.status,
        provider_status: providerRow.status,
        matched: amountMatch && statusMatch,
        db_record: dbRecord,
        provider_record: providerRow,
      };

      if (amountMatch && statusMatch) {
        matched.push(reconciliationMatch);
      } else {
        discrepancies.push(reconciliationMatch);
      }
    }
  }

  // Find orphaned provider records (in CSV but not in DB)
  const orphaned_provider = providerRows.filter((row) => {
    const refNum = normalizeReferenceNumber(
      row.reference_number || row.reference_id,
    );
    return refNum && !matchedProviderRefs.has(refNum);
  });

  // Find orphaned DB records (in DB but not in CSV)
  const orphaned_db = dbRecords.filter((record) => {
    const refNum = normalizeReferenceNumber(record.reference_number);
    return refNum && !matchedDbRefs.has(refNum);
  });

  const totalMatched = matched.length;
  const totalDiscrepancies = discrepancies.length;
  const totalOrphanedProvider = orphaned_provider.length;
  const totalOrphanedDb = orphaned_db.length;
  const matchRate =
    providerRows.length > 0
      ? ((totalMatched / providerRows.length) * 100).toFixed(2)
      : "0.00";

  return {
    total_provider_rows: providerRows.length,
    total_db_records: dbRecords.length,
    matched,
    discrepancies,
    orphaned_provider,
    orphaned_db,
    summary: {
      match_rate: `${matchRate}%`,
      total_matched: totalMatched,
      total_discrepancies: totalDiscrepancies,
      total_orphaned_provider: totalOrphanedProvider,
      total_orphaned_db: totalOrphanedDb,
    },
  };
}
