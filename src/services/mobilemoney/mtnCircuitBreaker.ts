import logger from "../../utils/logger";
import {
  recordCircuitBreakerTransition,
  setCircuitBreakerStateMetric,
} from "../../utils/metrics";

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface MtnCircuitBreakerOptions {
  failureThreshold?: number;
  rollingWindowMs?: number;
  cooldownPeriodMs?: number;
  requestTimeoutMs?: number;
  provider?: string;
  operation?: string;
  onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;
}

export interface CircuitBreakerOpenError {
  code: "CIRCUIT_BREAKER_OPEN";
  provider: string;
  operation: string;
  message: string;
  state: "OPEN";
  retryAfterMs: number;
}

export interface CircuitBreakerFallbackResponse<T = unknown> {
  success: false;
  provider: string;
  error: CircuitBreakerOpenError;
  data?: T;
}

export class MtnCircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private failureTimestamps: number[] = [];
  private openedAt = 0;
  private halfOpenProbeInFlight = false;

  readonly failureThreshold: number;
  readonly rollingWindowMs: number;
  readonly cooldownPeriodMs: number;
  readonly requestTimeoutMs: number;
  readonly provider: string;
  readonly operation: string;
  private readonly onStateChange?: (
    from: CircuitBreakerState,
    to: CircuitBreakerState,
  ) => void;

  constructor(options: MtnCircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.rollingWindowMs = options.rollingWindowMs ?? 60_000;
    this.cooldownPeriodMs = options.cooldownPeriodMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.provider = options.provider ?? "mtn";
    this.operation = options.operation ?? "collection";
    this.onStateChange = options.onStateChange;

    setCircuitBreakerStateMetric(this.provider, this.operation, "CLOSED");
  }

  getState(): CircuitBreakerState {
    const now = Date.now();
    if (this.state === "OPEN") {
      if (now - this.openedAt >= this.cooldownPeriodMs) {
        this.transitionTo("HALF_OPEN");
      }
    }
    return this.state;
  }

  isOpen(): boolean {
    return this.getState() === "OPEN";
  }

  isClosed(): boolean {
    return this.getState() === "CLOSED";
  }

  isHalfOpen(): boolean {
    return this.getState() === "HALF_OPEN";
  }

  getConsecutiveFailures(): number {
    this.cleanExpiredFailures(Date.now());
    return this.consecutiveFailures;
  }

  getRemainingCooldownMs(): number {
    if (this.state !== "OPEN") {
      return 0;
    }
    const elapsed = Date.now() - this.openedAt;
    return Math.max(0, this.cooldownPeriodMs - elapsed);
  }

  buildFallbackResponse<T = unknown>(): CircuitBreakerFallbackResponse<T> {
    const retryAfterMs = this.getRemainingCooldownMs();
    return {
      success: false,
      provider: this.provider,
      error: {
        code: "CIRCUIT_BREAKER_OPEN",
        provider: this.provider,
        operation: this.operation,
        message: `MTN MoMo ${this.operation} circuit breaker is OPEN. Requests failing fast.`,
        state: "OPEN",
        retryAfterMs,
      },
    };
  }

  private cleanExpiredFailures(now: number): void {
    const cutoff = now - this.rollingWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
    if (this.failureTimestamps.length < this.consecutiveFailures) {
      this.consecutiveFailures = this.failureTimestamps.length;
    }
  }

  recordSuccess(): void {
    const previousState = this.state;
    this.consecutiveFailures = 0;
    this.failureTimestamps = [];
    this.halfOpenProbeInFlight = false;

    if (previousState === "HALF_OPEN") {
      logger.info(
        { provider: this.provider, operation: this.operation },
        "Circuit breaker probe succeeded; transitioning from HALF_OPEN to CLOSED",
      );
      this.transitionTo("CLOSED");
    }
  }

  recordFailure(error?: unknown): void {
    const now = Date.now();
    const currentState = this.getState();

    if (currentState === "HALF_OPEN") {
      logger.warn(
        { provider: this.provider, operation: this.operation, error },
        "Circuit breaker probe failed in HALF_OPEN; tripping back to OPEN",
      );
      this.halfOpenProbeInFlight = false;
      this.trip(now);
      return;
    }

    if (currentState === "CLOSED") {
      this.cleanExpiredFailures(now);
      this.failureTimestamps.push(now);
      this.consecutiveFailures += 1;

      if (this.consecutiveFailures >= this.failureThreshold) {
        logger.error(
          {
            provider: this.provider,
            operation: this.operation,
            failures: this.consecutiveFailures,
            windowMs: this.rollingWindowMs,
          },
          `MTN MoMo ${this.operation} circuit breaker tripped: ${this.consecutiveFailures} consecutive failures/timeouts within ${this.rollingWindowMs}ms`,
        );
        this.trip(now);
      }
    }
  }

  trip(now: number = Date.now()): void {
    this.openedAt = now;
    this.transitionTo("OPEN");
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.failureTimestamps = [];
    this.openedAt = 0;
    this.halfOpenProbeInFlight = false;
    this.transitionTo("CLOSED");
  }

  private transitionTo(newState: CircuitBreakerState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;

    recordCircuitBreakerTransition(this.provider, this.operation, newState);

    if (this.onStateChange) {
      try {
        this.onStateChange(oldState, newState);
      } catch (err) {
        logger.error(
          { error: err },
          "Error in circuit breaker onStateChange listener",
        );
      }
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();

    if (state === "OPEN") {
      return this.buildFallbackResponse() as unknown as T;
    }

    if (state === "HALF_OPEN") {
      this.halfOpenProbeInFlight = true;
    }

    let timer: NodeJS.Timeout | null = null;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const timeoutError = new Error(
              `MTN MoMo ${this.operation} request timed out after ${this.requestTimeoutMs}ms`,
            );
            timeoutError.name = "TimeoutError";
            (timeoutError as any).code = "ETIMEDOUT";
            reject(timeoutError);
          }, this.requestTimeoutMs);
        }),
      ]);

      if (timer) clearTimeout(timer);

      if (
        result &&
        typeof result === "object" &&
        (result as Record<string, unknown>).success === false
      ) {
        this.recordFailure((result as Record<string, unknown>).error);
      } else {
        this.recordSuccess();
      }

      return result;
    } catch (error: unknown) {
      if (timer) clearTimeout(timer);
      this.recordFailure(error);
      throw error;
    }
  }
}
