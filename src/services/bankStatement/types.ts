export type BankStatementFormat = "mt940" | "camt053";

export type BankLineDirection = "credit" | "debit";

/** One booked bank statement line, normalised across MT940 and CAMT.053. */
export interface BankStatementLine {
  source: BankStatementFormat;
  /** Statement identifier (:20: in MT940, Stmt/Id in CAMT.053). */
  statementId: string;
  /** Account the statement belongs to (IBAN or local account number). */
  accountId: string;
  /** Customer / end-to-end reference supplied by the payer. */
  reference: string;
  /** Reference assigned by the account servicing bank. */
  bankReference: string;
  /** Unsigned decimal string, e.g. "1250.50". Never a float. */
  amount: string;
  /** ISO 4217 currency code. */
  currency: string;
  /** Reversals are flipped (a reversed credit is reported as a debit). */
  direction: BankLineDirection;
  reversal: boolean;
  /** ISO value date, YYYY-MM-DD. */
  valueDate: string;
  /** Free-text remittance information (:86: / Ustrd). */
  remittanceInfo: string;
}

export interface ParsedBankStatement {
  format: BankStatementFormat;
  lines: BankStatementLine[];
}

export class BankStatementParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankStatementParseError";
  }
}
