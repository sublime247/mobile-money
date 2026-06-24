import {
  MobileMoneyProvider,
  ProviderTransactionStatus,
  BatchPayoutItem,
  BatchPayoutResult,
} from "../mobileMoneyService";
import {
  providerFailoverTotal,
  transactionErrorsTotal,
} from "../../../utils/metrics";
import logger from "../../../utils/logger";
import { SmsPortalProvider } from "./smsPortalProvider";

// ── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNABORTED",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ERR_TIMEOUT",
]);

const TIMEOUT_MESSAGE_INDICATORS = [
  "timeout",
  "timed out",
  "timedout",
  "etimedout",
  "econnaborted",
  "esockettimedout",
];

const TIMEOUT_HTTP_CODES = new Set([408, 429, 502, 503, 504]);

// ── Types ────────────────────────────────────────────────────────────────────

export interface FallbackRouterConfig {
  timeoutMs: number;
  enableMetrics: boolean;
  fallbackOnHttpStatus: boolean;
}

type ProviderResult = {
  success: boolean;
  data?: unknown;
  error?: unknown;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function isTimeoutError(error: unknown): boolean {
  if (!error) return false;

  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as any).code;

  if (code && TIMEOUT_ERROR_CODES.has(code)) return true;

  const lower = msg.toLowerCase();
  for (const indicator of TIMEOUT_MESSAGE_INDICATORS) {
    if (lower.includes(indicator)) return true;
  }
  if (lower.includes("abort")) return true;

  const status = (error as any).status ?? (error as any).statusCode;
  if (status && TIMEOUT_HTTP_CODES.has(Number(status))) return true;

  return false;
}

function extractRequestId(phoneNumber: string, amount: string, requestId?: string): string | undefined {
  return requestId ?? `FALLBACK-${phoneNumber}-${amount}-${Date.now()}`;
}

// ── Router ───────────────────────────────────────────────────────────────────

export class FallbackRouter implements MobileMoneyProvider {
  private primary: MobileMoneyProvider;
  private fallback: SmsPortalProvider;
  private config: FallbackRouterConfig;

  constructor(
    primary: MobileMoneyProvider,
    fallback: SmsPortalProvider,
    config: Partial<FallbackRouterConfig> = {},
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.config = {
      timeoutMs: Number(config.timeoutMs ?? process.env.FALLBACK_ROUTER_TIMEOUT_MS ?? 15_000),
      enableMetrics: config.enableMetrics ?? true,
      fallbackOnHttpStatus: config.fallbackOnHttpStatus ?? true,
    };
  }

  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<ProviderResult> {
    const id = extractRequestId(phoneNumber, amount, requestId);
    const log = id ? logger.child({ requestId: id }) : logger;

    try {
      log.info("FallbackRouter: Trying primary provider");
      const result = await this.executeWithTimeout(
        () => this.primary.requestPayment(phoneNumber, amount, id),
      );
      return { success: result.success, data: result.data, error: result.error };
    } catch (primaryError: any) {
      if (!isTimeoutError(primaryError)) {
        log.warn(
          { error: primaryError.message },
          "FallbackRouter: Primary failed with non-timeout error",
        );
        return { success: false, error: primaryError };
      }

      log.warn(
        { error: primaryError.message },
        "FallbackRouter: Primary timed out, routing to SMS portal",
      );

      if (this.config.enableMetrics) {
        providerFailoverTotal.inc({
          type: "payment",
          from_provider: "primary",
          to_provider: "sms_portal",
          reason: String(primaryError).slice(0, 100),
        });
      }

      try {
        const fallbackResult = await this.fallback.requestPayment(phoneNumber, amount, id);
        return { success: fallbackResult.success, data: fallbackResult.data, error: fallbackResult.error };
      } catch (fallbackError: any) {
        logger.error(
          { error: fallbackError.message },
          "FallbackRouter: Both primary and fallback failed",
        );

        if (this.config.enableMetrics) {
          transactionErrorsTotal.inc({
            type: "payment",
            provider: "sms_portal",
            error_type: "fallback_failure",
          });
        }

        return { success: false, error: fallbackError };
      }
    }
  }

  async sendPayout(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<ProviderResult> {
    const id = extractRequestId(phoneNumber, amount, requestId);
    const log = id ? logger.child({ requestId: id }) : logger;

    try {
      log.info("FallbackRouter: Trying primary provider");
      const result = await this.executeWithTimeout(
        () => this.primary.sendPayout(phoneNumber, amount, id),
      );
      return { success: result.success, data: result.data, error: result.error };
    } catch (primaryError: any) {
      if (!isTimeoutError(primaryError)) {
        log.warn(
          { error: primaryError.message },
          "FallbackRouter: Primary failed with non-timeout error",
        );
        return { success: false, error: primaryError };
      }

      log.warn(
        { error: primaryError.message },
        "FallbackRouter: Primary timed out, routing to SMS portal",
      );

      if (this.config.enableMetrics) {
        providerFailoverTotal.inc({
          type: "payout",
          from_provider: "primary",
          to_provider: "sms_portal",
          reason: String(primaryError).slice(0, 100),
        });
      }

      try {
        const fallbackResult = await this.fallback.sendPayout(phoneNumber, amount, id);
        return { success: fallbackResult.success, data: fallbackResult.data, error: fallbackResult.error };
      } catch (fallbackError: any) {
        logger.error(
          { error: fallbackError.message },
          "FallbackRouter: Both primary and fallback failed",
        );

        if (this.config.enableMetrics) {
          transactionErrorsTotal.inc({
            type: "payout",
            provider: "sms_portal",
            error_type: "fallback_failure",
          });
        }

        return { success: false, error: fallbackError };
      }
    }
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: ProviderTransactionStatus }> {
    try {
      return await this.executeWithTimeout(
        () => this.primary.getTransactionStatus(referenceId),
      );
    } catch {
      logger.warn(
        { referenceId },
        "FallbackRouter: Primary status check failed, trying SMS portal",
      );
      return this.fallback.getTransactionStatus(referenceId);
    }
  }

  async sendBatchPayout(
    items: BatchPayoutItem[],
  ): Promise<{ success: boolean; results: BatchPayoutResult[]; error?: unknown }> {
    try {
      return await this.executeWithTimeout(
        () => {
          if (this.primary.sendBatchPayout) {
            return this.primary.sendBatchPayout(items);
          }
          throw new Error("Primary provider does not support batch payout");
        },
      );
    } catch (primaryError: any) {
      logger.warn(
        { error: primaryError.message, itemCount: items.length },
        "FallbackRouter: Primary batch payout failed, routing to SMS portal (individual)",
      );

      const results: BatchPayoutResult[] = [];
      let anySuccess = false;

      for (const item of items) {
        try {
          const result = await this.fallback.sendPayout(item.phoneNumber, item.amount, item.referenceId);
          results.push({
            referenceId: item.referenceId,
            success: result.success ?? false,
            ...(result.success ? { providerReference: String(result.data ?? "") } : { error: String(result.error ?? "") }),
          });
          if (result.success) anySuccess = true;
        } catch (itemError: any) {
          results.push({
            referenceId: item.referenceId,
            success: false,
            error: itemError.message,
          });
        }
      }

      return { success: anySuccess, results };
    }
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.config.timeoutMs;

    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`FallbackRouter: Operation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);

    return result;
  }
}
