import logger from "../../utils/logger";
import { pool } from "../../config/database";
import { withReadOnlyTransaction } from "../../database/readOnlyClient";
import { withRetry } from "../retry";
import { TravelRuleRecord } from "../../compliance/travelRule";

const REGULATORY_ENDPOINT = process.env.TRAVEL_RULE_EXPORT_ENDPOINT ?? "";
const EXPORT_TIMEOUT_MS = parseInt(process.env.TRAVEL_RULE_EXPORT_TIMEOUT_MS ?? "30000", 10);
const MAX_RETRY_ATTEMPTS = parseInt(process.env.TRAVEL_RULE_EXPORT_MAX_RETRIES ?? "3", 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.TRAVEL_RULE_EXPORT_RETRY_DELAY_MS ?? "1000", 10);

const REQUIRED_FATF_FIELDS: (keyof TravelRuleRecord)[] = [
  "id",
  "transactionId",
  "amount",
  "currency",
  "sender",
  "receiver",
  "createdAt",
];

interface ExportResult {
  success: boolean;
  exportedCount: number;
  failedCount: number;
  errors: string[];
}

interface FatfTravelRuleRecord {
  id: string;
  transaction_id: string;
  amount: number;
  currency: string;
  sender: {
    name: string;
    account: string;
    address?: string;
    dob?: string;
    id_number?: string;
  };
  receiver: {
    name: string;
    account: string;
    address?: string;
  };
  originating_vasp?: string;
  beneficiary_vasp?: string;
  created_at: string;
  exported_at?: string;
  exported_by?: string;
}

function validateFatfFormat(record: TravelRuleRecord): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const field of REQUIRED_FATF_FIELDS) {
    const value = (record as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === "") {
      errors.push(`Missing required FATF field: ${field}`);
    }
  }

  if (record.amount <= 0) {
    errors.push(`Invalid amount: ${record.amount}`);
  }

  if (!record.currency || record.currency.length !== 3) {
    errors.push(`Invalid currency code: ${record.currency}`);
  }

  if (record.sender.name === undefined || record.sender.name.trim() === "") {
    errors.push("Missing sender name");
  }

  if (record.sender.account === undefined || record.sender.account.trim() === "") {
    errors.push("Missing sender account");
  }

  if (record.receiver.name === undefined || record.receiver.name.trim() === "") {
    errors.push("Missing receiver name");
  }

  if (record.receiver.account === undefined || record.receiver.account.trim() === "") {
    errors.push("Missing receiver account");
  }

  return { valid: errors.length === 0, errors };
}

function toFatfFormat(record: TravelRuleRecord): FatfTravelRuleRecord {
  return {
    id: record.id,
    transaction_id: record.transactionId,
    amount: record.amount,
    currency: record.currency,
    sender: {
      name: record.sender.name,
      account: record.sender.account,
      address: record.sender.address,
      dob: record.sender.dob,
      id_number: record.sender.idNumber,
    },
    receiver: {
      name: record.receiver.name,
      account: record.receiver.account,
      address: record.receiver.address,
    },
    originating_vasp: record.originatingVasp,
    beneficiary_vasp: record.beneficiaryVasp,
    created_at: record.createdAt.toISOString(),
    exported_at: record.exportedAt?.toISOString(),
    exported_by: record.exportedBy,
  };
}

async function fetchPendingComplianceLogs(): Promise<TravelRuleRecord[]> {
  // #2483: compliance export reads run in a READ ONLY transaction on a replica
  // when available. The export marker write below deliberately stays on the
  // primary via pool.query.
  const result = await withReadOnlyTransaction((client) =>
    client.query<{
    id: string;
    transaction_id: string;
    amount: string;
    currency: string;
    sender_name: string;
    sender_account: string;
    sender_address: string | null;
    sender_dob: string | null;
    sender_id_number: string | null;
    receiver_name: string;
    receiver_account: string;
    receiver_address: string | null;
    originating_vasp: string | null;
    beneficiary_vasp: string | null;
    created_at: Date;
    exported_at: Date | null;
    exported_by: string | null;
  }>(
    `SELECT * FROM travel_rule_records
     WHERE exported_at IS NULL
     ORDER BY created_at ASC`,
    ),
  );

  return result.rows.map((row) => ({
    id: row.id,
    transactionId: row.transaction_id,
    amount: Number(row.amount),
    currency: row.currency,
    sender: {
      name: row.sender_name,
      account: row.sender_account,
      address: row.sender_address ?? undefined,
      dob: row.sender_dob ?? undefined,
      idNumber: row.sender_id_number ?? undefined,
    },
    receiver: {
      name: row.receiver_name,
      account: row.receiver_account,
      address: row.receiver_address ?? undefined,
    },
    originatingVasp: row.originating_vasp ?? undefined,
    beneficiaryVasp: row.beneficiary_vasp ?? undefined,
    createdAt: row.created_at,
    exportedAt: row.exported_at ?? undefined,
    exportedBy: row.exported_by ?? undefined,
  }));
}

async function transmitToRegulatoryEndpoint(
  payload: FatfTravelRuleRecord[],
): Promise<void> {
  if (!REGULATORY_ENDPOINT) {
    logger.warn("[travel-rule-export] No regulatory endpoint configured; skipping transmission");
    return;
  }

  await withRetry(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);

      try {
        const res = await fetch(REGULATORY_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": `travel-rule-${Date.now()}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const httpError = new Error(`Regulatory endpoint returned ${res.status}: ${body}`) as Error & { response?: { status: number } };
          httpError.response = { status: res.status };
          throw httpError;
        }

        return res;
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    },
    {
      maxAttempts: MAX_RETRY_ATTEMPTS,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      provider: "regulatory-endpoint",
    },
  );

  logger.info("[travel-rule-export] Successfully transmitted records to regulatory endpoint", {
    count: payload.length,
  });
}

async function markRecordsAsExported(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  await pool.query(
    `UPDATE travel_rule_records
     SET exported_at = NOW(), exported_by = $1
     WHERE id = ANY($2::uuid[])`,
    ["travel-rule-export-job", ids],
  );
}

export async function runTravelRuleExportJob(): Promise<void> {
  logger.info("[travel-rule-export] Starting Travel Rule compliance export job");

  const result: ExportResult = {
    success: true,
    exportedCount: 0,
    failedCount: 0,
    errors: [],
  };

  try {
    const pendingRecords = await fetchPendingComplianceLogs();
    logger.info("[travel-rule-export] Found pending compliance records to export", {
      count: pendingRecords.length,
    });

    if (pendingRecords.length === 0) {
      logger.info("[travel-rule-export] No pending records; nothing to export");
      return;
    }

    const validRecords: TravelRuleRecord[] = [];
    for (const record of pendingRecords) {
      const { valid, errors } = validateFatfFormat(record);
      if (!valid) {
        result.failedCount++;
        result.errors.push(...errors.map((e) => `[${record.id}] ${e}`));
        logger.warn("[travel-rule-export] FATF validation failed for record", {
          id: record.id,
          errors,
        });
      } else {
        validRecords.push(record);
      }
    }

    if (validRecords.length === 0) {
      logger.warn("[travel-rule-export] No records passed FATF format validation");
      result.success = false;
      return;
    }

    const fatfPayload = validRecords.map(toFatfFormat);
    await transmitToRegulatoryEndpoint(fatfPayload);

    const exportedIds = validRecords.map((r) => r.id);
    await markRecordsAsExported(exportedIds);

    result.exportedCount = exportedIds.length;
    result.success = true;

    logger.info("[travel-rule-export] Export job completed successfully", {
      exportedCount: result.exportedCount,
      failedCount: result.failedCount,
    });
  } catch (err) {
    result.success = false;
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    logger.error("[travel-rule-export] Export job failed:", err);
  }

  if (!result.success || result.errors.length > 0) {
    logger.warn("[travel-rule-export] Export job completed with issues", {
      success: result.success,
      exportedCount: result.exportedCount,
      failedCount: result.failedCount,
      errors: result.errors,
    });
  }
}