import { BankStatementLine } from "./types";

export interface PendingDeposit {
  id: string;
  /** Expected fiat amount; null when the wallet did not declare one (SEP-6). */
  amountIn: string | null;
}

export type MatchStatus =
  | "matched"
  | "unmatched"
  | "ambiguous"
  | "amount_mismatch"
  | "ignored";

export interface MatchOutcome {
  line: BankStatementLine;
  status: MatchStatus;
  depositId?: string;
  note?: string;
}

export interface MatchOptions {
  /** When set, lines in any other currency are ignored. */
  expectedCurrency?: string;
}

const SCALE = 7;

/** Decimal string -> integer units of 1e-7 (no floating point). */
export function toUnits(value: string): bigint {
  const s = value.trim().replace(/^\+/, "");
  const negative = s.startsWith("-");
  const [int, frac = ""] = (negative ? s.slice(1) : s).split(".");
  const units = BigInt(
    (int || "0") + frac.padEnd(SCALE, "0").slice(0, SCALE),
  );
  return negative ? -units : units;
}

export function amountsEqual(a: string, b: string): boolean {
  return toUnits(a) === toUnits(b);
}

const compact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Pure matching of statement lines to pending deposits. A deposit is
 * identified by its transaction id (the SEP-6 / SEP-24 instructions tell the
 * customer to quote it as the payment reference), which may appear with or
 * without dashes anywhere in the reference or remittance text.
 *
 * A deposit is consumed by at most one line, so a duplicated bank line can
 * never release the same deposit twice.
 */
export function matchStatementLines(
  lines: BankStatementLine[],
  deposits: PendingDeposit[],
  options: MatchOptions = {},
): MatchOutcome[] {
  const keyed = deposits.map((d) => ({ deposit: d, key: compact(d.id) }));
  const consumed = new Set<string>();

  return lines.map((line): MatchOutcome => {
    if (line.direction !== "credit" || line.reversal) {
      return { line, status: "ignored", note: "Not an incoming credit" };
    }
    if (
      options.expectedCurrency &&
      line.currency.toUpperCase() !== options.expectedCurrency.toUpperCase()
    ) {
      return {
        line,
        status: "ignored",
        note: `Currency ${line.currency} != expected ${options.expectedCurrency}`,
      };
    }

    const haystack = compact(
      `${line.reference} ${line.bankReference} ${line.remittanceInfo}`,
    );
    const candidates = keyed.filter(
      (k) => !consumed.has(k.deposit.id) && haystack.includes(k.key),
    );

    if (candidates.length === 0) {
      return { line, status: "unmatched", note: "No pending deposit reference found" };
    }
    if (candidates.length > 1) {
      return {
        line,
        status: "ambiguous",
        note: `Reference matches ${candidates.length} pending deposits`,
      };
    }

    const { deposit } = candidates[0];
    if (deposit.amountIn !== null && !amountsEqual(deposit.amountIn, line.amount)) {
      return {
        line,
        status: "amount_mismatch",
        depositId: deposit.id,
        note: `Expected ${deposit.amountIn}, bank credited ${line.amount}`,
      };
    }

    consumed.add(deposit.id);
    return { line, status: "matched", depositId: deposit.id };
  });
}
