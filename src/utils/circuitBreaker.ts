import CircuitBreaker, { CircuitBreakerOptions } from "opossum";
import {
  providerCircuitBreakerState,
  providerCircuitBreakerTransitionsTotal,
} from "./metrics";
import { checkMobileMoneyHealth } from "../services/mobilemoney/providers/healthCheck";

export interface CircuitBreakerActionResult<T> {
  success: boolean;
  data?: T;
  error?: unknown;
  provider?: string;
}

interface ExecuteWithCircuitBreakerOptions<T> {
  provider: string;
  operation: string;
  execute: () => Promise<CircuitBreakerActionResult<T>>;
  fallback?: (
    error: unknown,
  ) => Promise<CircuitBreakerActionResult<T>> | CircuitBreakerActionResult<T>;
}

type BreakerInvocation<T> = () => Promise<CircuitBreakerActionResult<T>>;
type BreakerFallback<T> = (
  error: unknown,
) => Promise<CircuitBreakerActionResult<T>> | CircuitBreakerActionResult<T>;

type ProviderCircuitBreaker<T> = CircuitBreaker<
  [BreakerInvocation<T>, BreakerFallback<T> | undefined],
  CircuitBreakerActionResult<T>
>;

const circuitBreakers = new Map<string, ProviderCircuitBreaker<unknown>>();

const CIRCUIT_STATE_VALUES = {
  closed: 0,
  half_open: 0.5,
  open: 1,
} as const;

function getCircuitKey(provider: string, operation: string): string {
  return `${provider}:${operation}`;
}

function getBreakerOptions(name: string): CircuitBreakerOptions {
  return {
    name,
    timeout: Number(process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS ?? 5_000),
    resetTimeout: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS ?? 30_000,
    ),
    rollingCountTimeout: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_ROLLING_WINDOW_MS ?? 300_000, // 5 minutes
    ),
    rollingCountBuckets: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_ROLLING_BUCKETS ?? 10,
    ),
    volumeThreshold: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD ?? 3,
    ),
    errorThresholdPercentage: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE ?? 50,
    ),
    capacity: Number(process.env.PROVIDER_CIRCUIT_BREAKER_CAPACITY ?? 100),
    enableSnapshots: false,
  };
}

function setCircuitStateMetric(
  provider: string,
  operation: string,
  state: keyof typeof CIRCUIT_STATE_VALUES,
): void {
  providerCircuitBreakerState.set(
    { provider, operation },
    CIRCUIT_STATE_VALUES[state],
  );
}

function emitStateTransitionMetric(
  provider: string,
  operation: string,
  state: keyof typeof CIRCUIT_STATE_VALUES,
): void {
  providerCircuitBreakerTransitionsTotal.inc({ provider, operation, state });
  setCircuitStateMetric(provider, operation, state);
}

function toExecutionError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Provider call failed");
}

function normalizeResult<T>(
  result: CircuitBreakerActionResult<T>,
): CircuitBreakerActionResult<T> {
  if (result.success) {
    return result;
  }

  throw toExecutionError(result.error);
}

function getOrCreateCircuitBreaker<T>(
  provider: string,
  operation: string,
): ProviderCircuitBreaker<T> {
  const key = getCircuitKey(provider, operation);
  const existing = circuitBreakers.get(key);
  if (existing) {
    return existing as ProviderCircuitBreaker<T>;
  }

  const breaker = new CircuitBreaker<
    [BreakerInvocation<T>, BreakerFallback<T> | undefined],
    CircuitBreakerActionResult<T>
  >(
    async (execute) => normalizeResult(await execute()),
    getBreakerOptions(key),
  );

  breaker.fallback(async (_execute, fallback, error) => {
    if (!fallback) {
      throw toExecutionError(error);
    }

    return normalizeResult(await fallback(error));
  });

  breaker.on("open", () => {
    console.error(
      `Circuit breaker opened for ${provider}:${operation} due to high error rate`,
    );
    emitStateTransitionMetric(provider, operation, "open");
  });
  breaker.on("halfOpen", () => {
    console.log(
      `Circuit breaker half-open for ${provider}:${operation}, testing recovery`,
    );
    emitStateTransitionMetric(provider, operation, "half_open");
  });
  breaker.on("close", () => {
    console.log(
      `Circuit breaker closed for ${provider}:${operation}, service recovered`,
    );
    emitStateTransitionMetric(provider, operation, "closed");
  });

  setCircuitStateMetric(provider, operation, "closed");
  circuitBreakers.set(key, breaker as ProviderCircuitBreaker<unknown>);
  return breaker;
}

export async function executeWithCircuitBreaker<T>(
  options: ExecuteWithCircuitBreakerOptions<T>,
): Promise<CircuitBreakerActionResult<T>> {
  const breaker = getOrCreateCircuitBreaker<T>(
    options.provider,
    options.operation,
  );

  return breaker.fire(options.execute, options.fallback);
}

export function isCircuitBreakerOpenError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === "EOPENBREAKER"
  );
}

export function resetCircuitBreakers(): void {
  for (const breaker of circuitBreakers.values()) {
    breaker.shutdown();
  }
  circuitBreakers.clear();
}

export async function checkAndResetCircuitBreaker(
  provider: string,
  operation: string,
): Promise<boolean> {
  const key = getCircuitKey(provider, operation);
  const breaker = circuitBreakers.get(key);
  if (!breaker) {
    return false;
  }

  // Only reset if open
  if (breaker.opened) {
    try {
      const healthResult = await checkMobileMoneyHealth();
      const providerHealth =
        healthResult.providers[provider as keyof typeof healthResult.providers];
      if (providerHealth && providerHealth.status === "up") {
        breaker.close();
        console.log(
          `Circuit breaker for ${provider}:${operation} reset due to health check`,
        );
        return true;
      }
    } catch (error) {
      console.error(`Failed to check health for ${provider}: ${error}`);
    }
  }
  return false;
}

export function getCircuitBreakerCount(): number {
  return circuitBreakers.size;
}
