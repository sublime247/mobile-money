import {
  MobileMoneyProvider,
  ProviderTransactionStatus,
} from "../mobilemoney/mobileMoneyService";
import { providerRateLimitService } from "../providerRateLimitService";
import logger from "../../utils/logger";

/**
 * Wrapper that intercepts provider responses to extract and store rate limit headers
 * This prevents provider lockout by automatically throttling requests
 */
export class RateLimitInterceptor {
  private providerName: string;

  constructor(providerName: string) {
    this.providerName = providerName;
  }

  /**
   * Wrap a provider with rate limit interception
   */
  wrap(provider: MobileMoneyProvider): MobileMoneyProvider {
    return {
      requestPayment: async (phoneNumber, amount, requestId) => {
        const result = await provider.requestPayment(
          phoneNumber,
          amount,
          requestId,
        );
        this.processResponse(result);
        return result;
      },

      sendPayout: async (phoneNumber, amount, requestId) => {
        const result = await provider.sendPayout(
          phoneNumber,
          amount,
          requestId,
        );
        this.processResponse(result);
        return result;
      },

      sendBatchPayout: async (items) => {
        const result = await provider.sendBatchPayout?.(items);
        if (result) {
          this.processResponse(result);
        }
        return result;
      },

      getTransactionStatus: async (referenceId) => {
        return provider.getTransactionStatus(referenceId);
      },
    };
  }

  /**
   * Process provider response to extract rate limit headers
   */
  private processResponse(result: {
    success: boolean;
    data?: unknown;
    error?: unknown;
  }): void {
    if (!result.success || !result.data) {
      // Check if error is a rate limit error
      if (result.error && this.isRateLimitError(result.error)) {
        this.handleRateLimitError(result.error);
      }
      return;
    }

    // Extract headers from response data if available
    const data = result.data as Record<string, unknown>;
    if (data?.headers) {
      const headers = data.headers as Record<
        string,
        string | string[] | undefined
      >;
      const rateLimitState = providerRateLimitService.extractRateLimitHeaders(
        this.providerName,
        headers,
      );

      if (
        rateLimitState.remaining !== undefined ||
        rateLimitState.limit !== undefined
      ) {
        providerRateLimitService.updateRateLimitState({
          provider: this.providerName,
          remaining: rateLimitState.remaining || 0,
          limit: rateLimitState.limit || 0,
          resetAt: rateLimitState.resetAt || Date.now() + 3600000,
          lastUpdated: new Date(),
        });
      }
    }
  }

  /**
   * Check if error is a rate limit error
   */
  private isRateLimitError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const errorObj = error as Record<string, unknown>;

    // Check HTTP status code
    if (errorObj.statusCode === 429 || errorObj.status === 429) {
      return true;
    }

    // Check error code
    const errorCode = (errorObj.code || errorObj.errorCode || "")
      .toString()
      .toLowerCase();
    if (
      errorCode.includes("rate_limit") ||
      errorCode.includes("throttle") ||
      errorCode === "429"
    ) {
      return true;
    }

    // Check error message
    const errorMessage = (errorObj.message || errorObj.error || "")
      .toString()
      .toLowerCase();
    if (
      errorMessage.includes("rate limit") ||
      errorMessage.includes("too many requests") ||
      errorMessage.includes("throttled")
    ) {
      return true;
    }

    return false;
  }

  /**
   * Handle rate limit error from provider
   */
  private async handleRateLimitError(error: unknown): Promise<void> {
    const errorObj = error as Record<string, unknown>;
    const retryAfter =
      typeof errorObj.retryAfter === "number"
        ? errorObj.retryAfter
        : typeof errorObj.retry_after === "number"
          ? errorObj.retry_after
          : undefined;

    await providerRateLimitService.handleRateLimitError(
      this.providerName,
      retryAfter,
    );

    logger.warn(
      {
        provider: this.providerName,
        error: errorObj,
        retryAfter,
      },
      "Provider rate limit error detected",
    );
  }
}

/**
 * Create a rate-limited provider wrapper
 */
export function createRateLimitedProvider(
  provider: MobileMoneyProvider,
  providerName: string,
): MobileMoneyProvider {
  const interceptor = new RateLimitInterceptor(providerName);
  return interceptor.wrap(provider);
}
