import {
  MtnCircuitBreaker,
  MtnCircuitBreakerOptions,
  CircuitBreakerState,
  CircuitBreakerFallbackResponse,
} from "./mtnCircuitBreaker";
import {
  MTNProvider,
  BatchPayoutItem,
  BatchPayoutResult,
} from "./providers/mtn";
import logger from "../../utils/logger";

export interface MtnServiceConfig {
  provider?: MTNProvider;
  circuitBreakerOptions?: MtnCircuitBreakerOptions;
}

export class MtnService {
  private readonly provider: MTNProvider;
  private readonly circuitBreaker: MtnCircuitBreaker;

  constructor(config: MtnServiceConfig = {}) {
    this.provider = config.provider ?? new MTNProvider();
    this.circuitBreaker = new MtnCircuitBreaker(
      config.circuitBreakerOptions ?? {
        failureThreshold: 5,
        rollingWindowMs: 60_000,
        cooldownPeriodMs: 30_000,
        provider: "mtn",
        operation: "collection",
      },
    );
  }

  getCircuitBreaker(): MtnCircuitBreaker {
    return this.circuitBreaker;
  }

  getCircuitState(): CircuitBreakerState {
    return this.circuitBreaker.getState();
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  /**
   * Request a payment (collection / request-to-pay) from a subscriber.
   *
   * The call is guarded by the MTN MoMo collection circuit breaker.
   * If the circuit breaker is OPEN, subsequent requests fail fast without
   * making outbound network calls, returning a structured graceful fallback error.
   */
  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<
    | {
        success: boolean;
        data?: unknown;
        referenceId?: string;
        providerResponseTimeMs?: number;
        error?: unknown;
      }
    | CircuitBreakerFallbackResponse
  > {
    const log = requestId ? logger.child({ requestId }) : logger;

    if (this.circuitBreaker.isOpen()) {
      log.warn(
        {
          provider: "mtn",
          operation: "collection",
          state: "OPEN",
          retryAfterMs: this.circuitBreaker.getRemainingCooldownMs(),
        },
        "MTN MoMo collection circuit breaker is OPEN; failing fast without outbound network call",
      );
      return this.circuitBreaker.buildFallbackResponse();
    }

    try {
      return await this.circuitBreaker.execute(async () => {
        return await this.provider.requestPayment(
          phoneNumber,
          amount,
          requestId,
        );
      });
    } catch (error: any) {
      log.error(
        {
          provider: "mtn",
          operation: "collection",
          error: error.message,
        },
        "MTN MoMo collection request failed or timed out",
      );
      return {
        success: false,
        error,
      };
    }
  }

  async sendPayout(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<{ success: boolean; error?: unknown }> {
    return this.provider.sendPayout(phoneNumber, amount, requestId);
  }

  async sendBatchPayout(
    items: BatchPayoutItem[],
    requestId?: string,
  ): Promise<{
    success: boolean;
    results: BatchPayoutResult[];
    error?: unknown;
  }> {
    return this.provider.sendBatchPayout(items, requestId);
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
    return this.provider.getTransactionStatus(referenceId);
  }
}
