import { executeWithCircuitBreaker } from "../../utils/circuitBreaker";
import {
  providerFailoverAlerts,
  providerFailoverTotal,
  transactionErrorsTotal,
  transactionTotal,
} from "../../utils/metrics";
import logger from "../../utils/logger";
import { providerSettingsService } from "../providerSettingsService";

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
