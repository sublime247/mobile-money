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
    requestId?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  sendPayout(
    phoneNumber: string,
    amount: string,
    requestId?: string,
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
 
const {
  MobileMoneyService: MobileMoneyServiceImpl,
} = require("./mobileMoneyService_impl.js");

const SENEGAL_PHONE_REGEX = /^\+221\d{9}$/;

export function isValidSenegalPhoneNumber(phoneNumber: string): boolean {
  return SENEGAL_PHONE_REGEX.test(phoneNumber.trim());
}

function isSenegalPhoneNumberCandidate(phoneNumber: string): boolean {
  const trimmed = phoneNumber.trim();
  const digits = trimmed.replace(/\D/g, "");

  return trimmed.startsWith("+221") || digits.startsWith("221");
}

function assertSupportedPhoneNumberFormat(phoneNumber: string): void {
  if (
    isSenegalPhoneNumberCandidate(phoneNumber) &&
    !isValidSenegalPhoneNumber(phoneNumber)
  ) {
    throw new Error(
      "Invalid Senegal phone number format. Use +221 followed by 9 digits.",
    );
  }
}

class MobileMoneyService extends MobileMoneyServiceImpl {
  async initiatePayment(provider: string, phoneNumber: string, amount: string) {
    assertSupportedPhoneNumberFormat(phoneNumber);
    return super.initiatePayment(provider, phoneNumber, amount);
  }

  async sendPayout(provider: string, phoneNumber: string, amount: string) {
    assertSupportedPhoneNumberFormat(phoneNumber);
    return super.sendPayout(provider, phoneNumber, amount);
  }

  async sendBatchPayout(provider: string, items: BatchPayoutItem[]) {
    for (const item of items) {
      assertSupportedPhoneNumberFormat(item.phoneNumber);
    }

    return super.sendBatchPayout(provider, items);
  }
}

export { MobileMoneyService };
