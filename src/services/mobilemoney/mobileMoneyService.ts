import { executeWithCircuitBreaker } from "../../utils/circuitBreaker";
import {
  providerFailoverAlerts,
  providerFailoverTotal,
  transactionErrorsTotal,
  transactionTotal,
} from "../../utils/metrics";
import logger from "../../utils/logger";
import { providerSettingsService } from "../providerSettingsService";
import { createError } from "../../middleware/errorHandler";
import { ERROR_CODES } from "../../constants/errorCodes";

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
  sendBatchPayout?(items: BatchPayoutItem[]): Promise<{
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
const CAMEROON_PHONE_REGEX = /^\+237\d{9}$/;
const UGANDA_PHONE_REGEX = /^\+256\d{9}$/;

export function isValidSenegalPhoneNumber(phoneNumber: string): boolean {
  return SENEGAL_PHONE_REGEX.test(phoneNumber.trim());
}

export function isValidCameroonPhoneNumber(phoneNumber: string): boolean {
  return CAMEROON_PHONE_REGEX.test(phoneNumber.trim());
}

export function isValidUgandaPhoneNumber(phoneNumber: string): boolean {
  return UGANDA_PHONE_REGEX.test(phoneNumber.trim());
}

function isSenegalPhoneNumberCandidate(phoneNumber: string): boolean {
  const trimmed = phoneNumber.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+221") || digits.startsWith("221");
}

function isCameroonPhoneNumberCandidate(phoneNumber: string): boolean {
  const trimmed = phoneNumber.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+237") || digits.startsWith("237");
}

function isUgandaPhoneNumberCandidate(phoneNumber: string): boolean {
  const trimmed = phoneNumber.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+256") || digits.startsWith("256");
}

function assertSupportedPhoneNumberFormat(phoneNumber: string): void {
  if (
    isSenegalPhoneNumberCandidate(phoneNumber) &&
    !isValidSenegalPhoneNumber(phoneNumber)
  ) {
    throw createError(
      ERROR_CODES.INVALID_PHONE_FORMAT,
      "Invalid Senegal phone number format. Use +221 followed by 9 digits.",
    );
  }
  if (
    isCameroonPhoneNumberCandidate(phoneNumber) &&
    !isValidCameroonPhoneNumber(phoneNumber)
  ) {
    throw createError(
      ERROR_CODES.INVALID_PHONE_FORMAT,
      "Invalid Cameroon phone number format. Use +237 followed by 9 digits.",
    );
  }
  if (
    isUgandaPhoneNumberCandidate(phoneNumber) &&
    !isValidUgandaPhoneNumber(phoneNumber)
  ) {
    throw createError(
      ERROR_CODES.INVALID_PHONE_FORMAT,
      "Invalid Uganda phone number format. Use +256 followed by 9 digits.",
    );
  }
}

class MobileMoneyService extends MobileMoneyServiceImpl {
  private async resolveProviderForMaintenance(provider: string) {
    const providerKey = provider.toLowerCase();
    const decision =
      await providerSettingsService.resolveMaintenanceRouting(providerKey);

    if (decision.action === "proceed") {
      return { providerKey, maintenance: null };
    }

    if (decision.action === "fallback") {
      logger.warn(
        {
          provider: providerKey,
          fallbackProvider: decision.provider,
          outageId: decision.outage.id,
          endsAt: decision.outage.ends_at,
        },
        "Provider is under scheduled maintenance; routing transaction to fallback provider",
      );

      return {
        providerKey: decision.provider,
        maintenance: {
          action: "fallback",
          originalProvider: providerKey,
          fallbackProvider: decision.provider,
          outageId: decision.outage.id,
          startsAt: decision.outage.starts_at,
          endsAt: decision.outage.ends_at,
          reason: decision.outage.reason,
          message: decision.message,
        },
      };
    }

    return {
      providerKey,
      maintenance: {
        action: "abort",
        originalProvider: providerKey,
        outageId: decision.outage.id,
        startsAt: decision.outage.starts_at,
        endsAt: decision.outage.ends_at,
        reason: decision.outage.reason,
        message: decision.message,
      },
    };
  }

  async initiatePayment(provider: string, phoneNumber: string, amount: string) {
    assertSupportedPhoneNumberFormat(phoneNumber);
    const routing = await this.resolveProviderForMaintenance(provider);

    if (routing.maintenance?.action === "abort") {
      return {
        success: false,
        provider: routing.providerKey,
        error: {
          code: "PROVIDER_MAINTENANCE",
          ...routing.maintenance,
        },
      };
    }

    const result = await super.initiatePayment(
      routing.providerKey,
      phoneNumber,
      amount,
    );
    return routing.maintenance
      ? { ...result, maintenance: routing.maintenance }
      : result;
  }

  async sendPayout(provider: string, phoneNumber: string, amount: string) {
    assertSupportedPhoneNumberFormat(phoneNumber);
    const routing = await this.resolveProviderForMaintenance(provider);

    if (routing.maintenance?.action === "abort") {
      return {
        success: false,
        provider: routing.providerKey,
        error: {
          code: "PROVIDER_MAINTENANCE",
          ...routing.maintenance,
        },
      };
    }

    const result = await super.sendPayout(
      routing.providerKey,
      phoneNumber,
      amount,
    );
    return routing.maintenance
      ? { ...result, maintenance: routing.maintenance }
      : result;
  }

  async sendBatchPayout(provider: string, items: BatchPayoutItem[]) {
    for (const item of items) {
      assertSupportedPhoneNumberFormat(item.phoneNumber);
    }

    const routing = await this.resolveProviderForMaintenance(provider);

    if (routing.maintenance?.action === "abort") {
      return {
        success: false,
        results: items.map((item) => ({
          referenceId: item.referenceId,
          success: false,
          error: JSON.stringify({
            code: "PROVIDER_MAINTENANCE",
            ...routing.maintenance,
          }),
        })),
        error: {
          code: "PROVIDER_MAINTENANCE",
          ...routing.maintenance,
        },
      };
    }

    const result = await super.sendBatchPayout(routing.providerKey, items);
    return routing.maintenance
      ? { ...result, maintenance: routing.maintenance }
      : result;
  }
}

export { MobileMoneyService };
