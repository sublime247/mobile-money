import { executeWithCircuitBreaker } from "../../utils/circuitBreaker";
import {
  buildProviderCircuitOpenResponse,
  isCircuitBreakerOpenError,
} from "../providerCircuitBreaker";
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
import axios from "axios";
import {
  attachTelcoTracingInterceptor,
  withTelcoSpan,
} from "../../utils/telcoTracing";

// Providers that use the default axios export report the telco HTTP status to
// the active telco span through this interceptor (client instances attach it
// themselves).
attachTelcoTracingInterceptor(axios);

export type ProviderTransactionStatus =
  "completed" | "failed" | "pending" | "unknown";

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
const KENYA_PHONE_REGEX = /^\+254\d{9}$/;

export function isValidSenegalPhoneNumber(phoneNumber: string): boolean {
  return SENEGAL_PHONE_REGEX.test(phoneNumber.trim());
}

export function isValidCameroonPhoneNumber(phoneNumber: string): boolean {
  return CAMEROON_PHONE_REGEX.test(phoneNumber.trim());
}

export function isValidUgandaPhoneNumber(phoneNumber: string): boolean {
  return UGANDA_PHONE_REGEX.test(phoneNumber.trim());
}

export function isValidKenyaPhoneNumber(phoneNumber: string): boolean {
  return KENYA_PHONE_REGEX.test(phoneNumber.trim());
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

function isKenyaPhoneNumberCandidate(phoneNumber: string): boolean {
  const trimmed = phoneNumber.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+254") || digits.startsWith("254");
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
  if (
    isKenyaPhoneNumberCandidate(phoneNumber) &&
    !isValidKenyaPhoneNumber(phoneNumber)
  ) {
    throw createError(
      ERROR_CODES.INVALID_PHONE_FORMAT,
      "Invalid Kenya phone number format. Use +254 followed by 9 digits.",
    );
  }
}

/**
 * Whether a rejection from `super.initiatePayment`/`sendPayout` is an
 * unrecovered circuit-breaker-open failure (#1962): every provider in the
 * failover chain had an open breaker, so `executeProviderOperation` in the
 * compiled dispatcher rethrew as a `MobileMoneyError` wrapping the original
 * `EOPENBREAKER` error. Checks both the wrapper and its `originalError`,
 * since the dispatcher always wraps the underlying cause.
 */
function isUnrecoveredCircuitBreakerFailure(error: unknown): boolean {
  if (isCircuitBreakerOpenError(error)) {
    return true;
  }
  const originalError = (error as { originalError?: unknown } | undefined)
    ?.originalError;
  return isCircuitBreakerOpenError(originalError);
}

/**
 * Environments in which the mock sandbox provider (#2274) is activated
 * automatically, regardless of which real provider the caller requested.
 * This lets integration tests and staging smoke tests exercise the full
 * deposit/payout code path without needing live MTN/Orange/Airtel
 * credentials, matching how `IS_SANDBOX=true` already auto-routes to
 * `"mock"` in the compiled dispatcher (mobileMoneyService_impl.js) when the
 * CALLER already passes `provider: "mock"` explicitly - this extends that
 * same mock routing to also trigger automatically from NODE_ENV, without
 * requiring every call site to know to pass "mock" itself.
 */
const MOCK_PROVIDER_ACTIVATION_ENVS = new Set(["test", "sandbox"]);

/**
 * Resolves the provider key actually used for a request. Returns `"mock"`
 * when `NODE_ENV` is one of `MOCK_PROVIDER_ACTIVATION_ENVS`, otherwise
 * returns the requested provider unchanged.
 */
function resolveSandboxProviderOverride(requestedProvider: string): string {
  if (MOCK_PROVIDER_ACTIVATION_ENVS.has(process.env.NODE_ENV ?? "")) {
    return "mock";
  }
  return requestedProvider;
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
    const routing = await this.resolveProviderForMaintenance(
      resolveSandboxProviderOverride(provider),
    );

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

    let result;
    try {
      result = await withTelcoSpan(
        {
          provider: routing.providerKey,
          operation: "initiatePayment",
          phoneNumber,
        },
        () => super.initiatePayment(routing.providerKey, phoneNumber, amount),
      );
    } catch (error) {
      if (isUnrecoveredCircuitBreakerFailure(error)) {
        return buildProviderCircuitOpenResponse(
          routing.providerKey,
          "requestPayment",
        );
      }
      throw error;
    }
    return routing.maintenance
      ? { ...result, maintenance: routing.maintenance }
      : result;
  }

  async sendPayout(provider: string, phoneNumber: string, amount: string) {
    assertSupportedPhoneNumberFormat(phoneNumber);
    const routing = await this.resolveProviderForMaintenance(
      resolveSandboxProviderOverride(provider),
    );

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

    let result;
    try {
      result = await withTelcoSpan(
        {
          provider: routing.providerKey,
          operation: "sendPayout",
          phoneNumber,
        },
        () => super.sendPayout(routing.providerKey, phoneNumber, amount),
      );
    } catch (error) {
      if (isUnrecoveredCircuitBreakerFailure(error)) {
        return buildProviderCircuitOpenResponse(
          routing.providerKey,
          "sendPayout",
        );
      }
      throw error;
    }
    return routing.maintenance
      ? { ...result, maintenance: routing.maintenance }
      : result;
  }

  async sendBatchPayout(provider: string, items: BatchPayoutItem[]) {
    for (const item of items) {
      assertSupportedPhoneNumberFormat(item.phoneNumber);
    }

    const routing = await this.resolveProviderForMaintenance(
      resolveSandboxProviderOverride(provider),
    );

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

    let result;
    try {
      result = await withTelcoSpan(
        {
          provider: routing.providerKey,
          operation: "sendBatchPayout",
          phoneNumber: items[0]?.phoneNumber,
        },
        () => super.sendBatchPayout(routing.providerKey, items),
      );
    } catch (error) {
      if (isUnrecoveredCircuitBreakerFailure(error)) {
        const circuitResponse = buildProviderCircuitOpenResponse(
          routing.providerKey,
          "sendBatchPayout",
        );
        return {
          success: false,
          results: items.map((item) => ({
            referenceId: item.referenceId,
            success: false,
            error: JSON.stringify(circuitResponse.error),
          })),
          error: circuitResponse.error,
        };
      }
      throw error;
    }
    return routing.maintenance
      ? { ...result, maintenance: routing.maintenance }
      : result;
  }
}

export { MobileMoneyService, resolveSandboxProviderOverride };
