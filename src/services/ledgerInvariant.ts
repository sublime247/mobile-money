import { ERROR_CODES } from "../constants/errorCodes";
import logger from "../utils/logger";
import { recordAdminAction } from "./auditLogger";

/** Ledger amounts carry 7 decimal places (Stellar precision, NUMERIC(20,7)). */
export const LEDGER_DECIMAL_PLACES = 7;
const SCALE = 10 ** LEDGER_DECIMAL_PLACES;

export const ACCOUNTING_DISCREPANCY_ACTION = "ACCOUNTING_DISCREPANCY_UNBALANCED_ENTRY";

export interface InvariantEntry {
  account_code: string;
  debit_amount?: number;
  credit_amount?: number;
}

/** Thrown when a journal entry's debits and credits differ at 7 dp. */
export class UnbalancedLedgerException extends Error {
  code = ERROR_CODES.INTERNAL_ERROR;
  statusCode = 500;
  details: Record<string, unknown>;

  constructor(
    public readonly totalDebits: string,
    public readonly totalCredits: string,
    public readonly difference: string,
    public readonly referenceNumber?: string,
  ) {
    // Message prefix kept stable: callers/alerts already match on it.
    super(`Transaction not balanced: debits=${totalDebits} credits=${totalCredits}`);
    this.name = "UnbalancedLedgerException";
    this.details = { totalDebits, totalCredits, difference, referenceNumber };
  }
}

/**
 * Number -> integer units of 1e-7. Rounds half-up to 7 dp exactly as the
 * NUMERIC(20,7) cast inside post_transaction() does, so this check agrees with
 * what the database would store (converted amounts may carry extra digits).
 */
function toUnits(amount: number, label: string): bigint {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return BigInt(Math.round(amount * SCALE));
}

export function formatUnits(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const int = abs / BigInt(SCALE);
  const frac = (abs % BigInt(SCALE)).toString().padStart(LEDGER_DECIMAL_PLACES, "0");
  return `${neg ? "-" : ""}${int}.${frac}`;
}

export interface BalanceTotals {
  totalDebits: string;
  totalCredits: string;
}

/**
 * Verifies sum(debits) == sum(credits) exactly to 7 decimal places, using
 * integer arithmetic (no float tolerance). Throws UnbalancedLedgerException
 * otherwise. Call before anything is written to the database.
 */
export function assertLedgerBalanced(
  entries: InvariantEntry[],
  referenceNumber?: string,
): BalanceTotals {
  let debits = 0n;
  let credits = 0n;
  entries.forEach((e, i) => {
    debits += toUnits(e.debit_amount ?? 0, `Ledger entry ${i + 1} debit_amount`);
    credits += toUnits(e.credit_amount ?? 0, `Ledger entry ${i + 1} credit_amount`);
  });

  const totals = { totalDebits: formatUnits(debits), totalCredits: formatUnits(credits) };
  if (debits !== credits) {
    throw new UnbalancedLedgerException(
      totals.totalDebits,
      totals.totalCredits,
      formatUnits(debits - credits),
      referenceNumber,
    );
  }
  return totals;
}

/**
 * Records an accounting discrepancy event in the tamper-evident audit log
 * when an unbalanced posting is attempted. Never throws: the posting is
 * already being rejected, and audit failure must not mask that.
 *
 * audit_logs.admin_id references users(id), so the actor is the user who
 * posted the entry, else SYSTEM_AUDIT_USER_ID. With neither, the event is
 * still emitted at error level so it is not lost.
 */
export async function recordUnbalancedAttempt(
  exception: UnbalancedLedgerException,
  context: {
    referenceNumber: string;
    transactionId?: string;
    postedBy?: string;
    entries: InvariantEntry[];
  },
): Promise<void> {
  const payload = {
    reference_number: context.referenceNumber,
    transaction_id: context.transactionId ?? null,
    total_debits: exception.totalDebits,
    total_credits: exception.totalCredits,
    difference: exception.difference,
    entry_count: context.entries.length,
    account_codes: context.entries.map((e) => e.account_code),
  };

  logger.error(payload, "[ledger] Unbalanced journal entry rejected before commit");

  const actorId = context.postedBy ?? process.env.SYSTEM_AUDIT_USER_ID;
  if (!actorId) {
    logger.error(
      payload,
      "[ledger] No actor available for audit_logs (set SYSTEM_AUDIT_USER_ID); discrepancy logged only",
    );
    return;
  }

  try {
    await recordAdminAction({
      actorId,
      action: ACCOUNTING_DISCREPANCY_ACTION,
      resource: "ledger_entry",
      resourceId: context.referenceNumber,
      before: null,
      after: payload,
    });
  } catch (error) {
    logger.error({ error }, "[ledger] Failed to record accounting discrepancy audit event");
  }
}
