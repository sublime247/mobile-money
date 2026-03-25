import { Transaction, TransactionStatus } from "../models/transaction";
import { KYCLevel } from "../config/limits";

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

export interface TransactionResponse {
  transactionId: string;
  referenceNumber: string;
  status: TransactionStatus;
  jobId: string | undefined;
}

export interface TransactionDetailResponse extends Transaction {
  jobProgress: number | null;
  reason?: string;
}

export interface CancelTransactionResponse {
  message: string;
  transaction: Transaction;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ErrorResponse {
  error: string;
  message?: string;
}

export interface LimitExceededDetails {
  kycLevel: KYCLevel;
  dailyLimit: number;
  currentDailyTotal: number;
  remainingLimit: number;
  message?: string;
  upgradeAvailable?: boolean;
}

export interface LimitExceededErrorResponse {
  error: string;
  details: LimitExceededDetails;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthCheckResponse {
  status: "ok";
  timestamp: string;
}

export interface ReadinessCheckResponse {
  status: "ready" | "not ready";
  checks: Record<string, string>;
  timestamp: string;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  paused: boolean;
}

export interface QueueHealthResponse {
  status: "healthy" | "degraded";
  timestamp: string;
  queue: string;
  stats: QueueStats;
}

export interface QueueActionResponse {
  success: boolean;
  message: string;
}
