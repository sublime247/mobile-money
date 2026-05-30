/**
 * Types for the provider reconciliation system.
 */

/** Status of a single payout as tracked locally. */
export type PayoutStatus =
  | "pending"
  | "completed"
  | "failed"
  | "mismatched"
  | "missing_local"
  | "missing_remote";

/** A payout record as stored in the local ledger. */
export interface LocalPayoutRecord {
  /** Unique payout / transaction ID. */
  id: string;
  /** Amount in the smallest currency unit (e.g. cents). */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
  /** Recipient identifier (phone number, wallet address, etc.). */
  recipient: string;
  /** Current status known locally. */
  status: PayoutStatus;
  /** ISO-8601 timestamp of when the payout was initiated. */
  createdAt: string;
}

/** A payout record as returned by the provider / remote API. */
export interface RemotePayoutRecord {
  id: string;
  amount: number;
  currency: string;
  recipient: string;
  status: string;
  createdAt: string;
}

/** The result of reconciling a single payout. */
export interface ReconciliationEntry {
  payoutId: string;
  localStatus: string | null;
  remoteStatus: string | null;
  localAmount: number | null;
  remoteAmount: number | null;
  match: boolean;
  discrepancy: string | null;
}

/** Aggregated result of a full reconciliation run. */
export interface ReconciliationReport {
  /** ISO-8601 timestamp of when the reconciliation started. */
  reconciledAt: string;
  totalLocal: number;
  totalRemote: number;
  matched: number;
  mismatched: number;
  missingLocal: number;
  missingRemote: number;
  entries: ReconciliationEntry[];
}
