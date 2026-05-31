import { executeWithCircuitBreaker } from "../../utils/circuitBreaker";
import {
  providerFailoverAlerts,
  providerFailoverTotal,
  transactionErrorsTotal,
  transactionTotal,
} from "../../utils/metrics";
import logger from "../../utils/logger";

export type ProviderTransactionStatus =
  | "completed"
  | "failed"
  | "pending"
  | "unknown";

export interface BatchPayoutItem {
  referenceId: string;
  phoneNumber: string;
  amount: string;
}

export interface BatchPayoutResult {
  referenceId: string;
  success: boolean;
  error?: string;
  providerReference?: string;
}

export interface MobileMoneyProvider {
  requestPayment(
    phoneNumber: string,
    amount: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  sendPayout(
    phoneNumber: string,
    amount: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  sendBatchPayout?(
    items: BatchPayoutItem[],
  ): Promise<{
    success: boolean;
    results: BatchPayoutResult[];
    error?: unknown;
  }>;
  getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: ProviderTransactionStatus }>;
}

// The source TypeScript implementation is currently unavailable in this clone,
// but the compiled CommonJS artifact is committed and used throughout the app.
// Re-export it here so TypeScript consumers can continue importing the module.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MobileMoneyService } = require("./mobileMoneyService.js");

export { MobileMoneyService };
