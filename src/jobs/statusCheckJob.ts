import { pool } from "../config/database";
import { AirtelService } from "../services/mobilemoney/providers/airtel";
import { MTNProvider } from "../services/mobilemoney/providers/mtn";
import { OrangeProvider } from "../services/mobilemoney/providers/orange";

type WatchdogResult = "completed" | "failed";

interface StaleTransactionRow {
  id: string;
  reference_number: string;
  provider: string;
  created_at: Date;
}

interface ProviderStatusResult {
  ok: boolean;
  rawStatus: string | null;
}

function normalizeStatusValue(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/g, "_");
}

function collectStatusCandidates(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const obj = payload as Record<string, unknown>;
  const directKeys = [
    "status",
    "transactionStatus",
    "financialTransactionStatus",
    "state",
    "result",
  ];

  const nestedObjects = [
    obj.data,
    obj.transaction,
    obj.result,
    obj.response,
    obj.output,
  ];

  const nestedKeys = ["status", "transactionStatus", "state", "result"];
  const candidates: string[] = [];

  for (const key of directKeys) {
    const value = obj[key];
    if (typeof value === "string") {
      candidates.push(value);
    }
  }

  for (const nested of nestedObjects) {
    if (!nested || typeof nested !== "object") {
      continue;
    }

    const nestedObj = nested as Record<string, unknown>;
    for (const key of nestedKeys) {
      const value = nestedObj[key];
      if (typeof value === "string") {
        candidates.push(value);
      }
    }
  }

  return candidates;
}

function classifyProviderStatus(rawStatus: string | null): WatchdogResult {
  if (!rawStatus) {
    return "failed";
  }

  const normalized = normalizeStatusValue(rawStatus);

  const successStates = new Set([
    "SUCCESS",
    "SUCCESSFUL",
    "COMPLETED",
    "COMPLETE",
    "APPROVED",
    "PAID",
  ]);
  if (successStates.has(normalized)) {
    return "completed";
  }

  const failedStates = new Set([
    "FAILED",
    "FAILURE",
    "ERROR",
    "REJECTED",
    "DECLINED",
    "CANCELLED",
    "CANCELED",
    "EXPIRED",
    "TIMEOUT",
    "TIMED_OUT",
  ]);
  if (failedStates.has(normalized)) {
    return "failed";
  }

  const pendingStates = new Set([
    "PENDING",
    "PROCESSING",
    "IN_PROGRESS",
    "INPROGRESS",
    "INITIATED",
    "ACCEPTED",
    "QUEUED",
  ]);
  if (pendingStates.has(normalized)) {
    // Stale beyond threshold is considered expired to avoid infinite pending rows.
    return "failed";
  }

  return "failed";
}

async function fetchProviderStatus(
  provider: string,
  referenceNumber: string,
): Promise<ProviderStatusResult> {
  const providerKey = provider.toLowerCase();

  if (providerKey === "airtel") {
    const result = await new AirtelService().checkStatus(referenceNumber);
    if (!result.success) {
      return { ok: false, rawStatus: null };
    }

    const candidates = collectStatusCandidates(result.data);
    return { ok: true, rawStatus: candidates[0] ?? null };
  }

  if (providerKey === "orange") {
    const result = await new OrangeProvider().checkStatus(referenceNumber);
    if (!result.success) {
      return { ok: false, rawStatus: null };
    }

    const candidates = collectStatusCandidates(result.data);
    return { ok: true, rawStatus: candidates[0] ?? null };
  }

  if (providerKey === "mtn") {
    const result = await new MTNProvider().checkStatus(referenceNumber);
    if (!result.success) {
      return { ok: false, rawStatus: null };
    }

    const candidates = collectStatusCandidates(result.data);
    return { ok: true, rawStatus: candidates[0] ?? null };
  }

  return { ok: false, rawStatus: null };
}

async function finalizeStaleTransaction(
  tx: StaleTransactionRow,
  outcome: WatchdogResult,
  providerStatus: string | null,
): Promise<void> {
  const finalStatus = outcome === "completed" ? "completed" : "failed";

  await pool.query(
    `UPDATE transactions
     SET status = $1,
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [
      finalStatus,
      JSON.stringify({
        watchdog: {
          reason: outcome === "completed" ? "PROVIDER_CONFIRMED" : "EXPIRED",
          staleTransaction: true,
          checkedAt: new Date().toISOString(),
          providerStatus,
        },
      }),
      tx.id,
    ],
  );
}

/**
 * Status Check Job
 * Schedule: Every hour (0 * * * *)
 * Resolves transactions stuck in 'pending' longer than 12 hours.
 *
 * Behavior:
 * - Calls provider "Get Status" for each stale transaction
 * - Marks as completed if provider confirms success
 * - Marks as failed with watchdog reason EXPIRED for non-final/failed/unknown statuses
 */
export async function runStatusCheckJob(): Promise<void> {
  const thresholdHours = parseInt(process.env.STALE_TRANSACTION_HOURS || "12", 10);
  const thresholdMinutes = parseInt(
    process.env.STUCK_TRANSACTION_MINUTES || String(thresholdHours * 60),
    10,
  );

  const result = await pool.query(
    `SELECT id, reference_number, provider, created_at
     FROM transactions
     WHERE status = 'pending'
       AND created_at < NOW() - INTERVAL '${thresholdMinutes} minutes'`,
  );

  if (result.rows.length === 0) {
    console.log("[status-check] No stuck transactions found");
    return;
  }

  let completed = 0;
  let expired = 0;

  console.warn(
    `[status-check] ${result.rows.length} stuck pending transaction(s):`,
  );

  for (const row of result.rows as StaleTransactionRow[]) {
    console.warn(
      `[status-check]   id=${row.id} ref=${row.reference_number} created_at=${row.created_at}`,
    );

    try {
      const providerResult = await fetchProviderStatus(
        row.provider,
        row.reference_number,
      );

      const outcome = providerResult.ok
        ? classifyProviderStatus(providerResult.rawStatus)
        : "failed";

      await finalizeStaleTransaction(row, outcome, providerResult.rawStatus);

      if (outcome === "completed") {
        completed++;
      } else {
        expired++;
      }
    } catch (error) {
      console.error(
        `[status-check] provider status check failed for ${row.id}; expiring transaction`,
        error,
      );
      await finalizeStaleTransaction(row, "failed", null);
      expired++;
    }
  }

  console.log(
    `[status-check] finalized stale pending transactions: completed=${completed} expired=${expired}`,
  );
}
