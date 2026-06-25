import logger from "./logger";
import CircuitBreaker, { CircuitBreakerOptions } from "opossum";
import {
  providerCircuitBreakerState,
  providerCircuitBreakerTransitionsTotal,
} from "./metrics";
import { checkMobileMoneyHealth } from "../services/mobilemoney/providers/healthCheck";
import { providerSettingsService } from "../services/providerSettingsService";

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

// Exported for testing only — callers should use getBreakerOptions()
export function _resolveFailureThreshold(provider: string): number | null {
  const providerEnv = `${provider.toUpperCase()}_CIRCUIT_BREAKER_FAILURE_THRESHOLD`;
  const globalEnv = "PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD";
  const raw = process.env[providerEnv] ?? process.env[globalEnv];
  return raw !== undefined ? Number(raw) : null;
}

// Exported for testing only — callers should use getBreakerOptions()
export function _resolveTimeoutMs(provider: string): number | null {
  const providerEnv = `${provider.toUpperCase()}_CIRCUIT_BREAKER_TIMEOUT_MS`;
  const globalEnv = "PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS";
  const raw = process.env[providerEnv] ?? process.env[globalEnv];
  return raw !== undefined ? Number(raw) : null;
}

async function getBreakerOptions(name: string, provider: string): Promise<CircuitBreakerOptions> {
  let settings: import("../services/providerSettingsService").ProviderSettings | null = null;
  try {
    settings = await providerSettingsService.getProviderSettings(provider);
  } catch {
    // DB unavailable — fall back to env vars / defaults
  }

  const providerThreshold = _resolveFailureThreshold(provider);
  const volumeThreshold = settings
    ? settings.failure_threshold
    : (providerThreshold ?? Number(process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD ?? 3));

  const providerTimeout = _resolveTimeoutMs(provider);
  const timeoutMs = settings
    ? settings.timeout_ms
    : (providerTimeout ?? Number(process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS ?? 5_000));

  return {
    name,
    timeout: timeoutMs,
    resetTimeout: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS ?? 30_000,
    ),
    rollingCountTimeout: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_ROLLING_WINDOW_MS ?? 300_000, // 5 minutes
    ),
    rollingCountBuckets: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_ROLLING_BUCKETS ?? 10,
    ),
    volumeThreshold,
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

async function getOrCreateCircuitBreaker<T>(
  provider: string,
  operation: string,
): Promise<ProviderCircuitBreaker<T>> {
  const key = getCircuitKey(provider, operation);
  const existing = circuitBreakers.get(key);
  if (existing) {
    return existing as ProviderCircuitBreaker<T>;
  }

  const options = await getBreakerOptions(key, provider);

  const breaker = new CircuitBreaker<
    [BreakerInvocation<T>, BreakerFallback<T> | undefined],
    CircuitBreakerActionResult<T>
  >(async (execute) => normalizeResult(await execute()), options);

  breaker.fallback(async (_execute, fallback, error) => {
    if (!fallback) {
      throw toExecutionError(error);
    }

    return normalizeResult(await fallback(error));
  });

  breaker.on("open", () => {
    logger.error(`Circuit breaker opened for ${provider}:${operation} due to high error rate`);
    emitStateTransitionMetric(provider, operation, "open");
  });
  breaker.on("halfOpen", () => {
    console.log(`Circuit breaker half-open for ${provider}:${operation}, testing recovery`);
    emitStateTransitionMetric(provider, operation, "half_open");
  });
  breaker.on("close", () => {
    console.log(`Circuit breaker closed for ${provider}:${operation}, service recovered`);
    emitStateTransitionMetric(provider, operation, "closed");
  });

  setCircuitStateMetric(provider, operation, "closed");
  circuitBreakers.set(key, breaker as ProviderCircuitBreaker<unknown>);
  return breaker;
}

export async function executeWithCircuitBreaker<T>(
  options: ExecuteWithCircuitBreakerOptions<T>,
): Promise<CircuitBreakerActionResult<T>> {
  const breaker = await getOrCreateCircuitBreaker<T>(
    options.provider,
    options.operation,
  );

  return breaker.fire(options.execute, options.fallback);
}

export function isCircuitBreakerOpenError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EOPENBREAKER"
  );
}

export function resetCircuitBreakers(): void {
  for (const breaker of circuitBreakers.values()) {
    try {
      breaker.shutdown();
    } catch {
      // ignore individual shutdown failures
    }
  }
  circuitBreakers.clear();
}

export function resetCircuitBreakerForProvider(provider: string): void {
  for (const [key, breaker] of circuitBreakers.entries()) {
    if (key.startsWith(`${provider}:`)) {
      breaker.shutdown();
      circuitBreakers.delete(key);
    }
  }
}

export async function checkAndResetCircuitBreaker(provider: string, operation: string): Promise<boolean> {
  const key = getCircuitKey(provider, operation);
  const breaker = circuitBreakers.get(key);
  if (!breaker) {
    return false;
  }

  // Only attempt to reset if the circuit is open or half-open
  const state = (breaker as any).toJSON().state as { open: boolean; halfOpen: boolean };
  if (!state?.open && !state?.halfOpen) {
    return false;
  }

  try {
    const healthResult = await checkMobileMoneyHealth();
    const providerHealth = healthResult.providers[provider as keyof typeof healthResult.providers];
    if (providerHealth && providerHealth.status === "up") {
      breaker.close();
      console.log(`Circuit breaker for ${provider}:${operation} reset due to health check`);
      return true;
    }
  } catch (error) {
    logger.error(`Failed to check health for ${provider}: ${error}`);
  }
  return false;
}

export function getCircuitBreakerCount(): number {
  return circuitBreakers.size;
}

/**
 * Programmatically open (trip) the circuit breaker for a provider+operation.
 * Creates the breaker if it doesn't exist yet.
 */
export async function tripCircuitBreaker(
  provider: string,
  operation: string,
): Promise<void> {
  const breaker = await getOrCreateCircuitBreaker(provider, operation);
  // opossum exposes open() on its prototype; use the internal flag as fallback
  if (typeof (breaker as any).open === "function") {
    (breaker as any).open();
  } else {
    // Force-open by marking the breaker via its internal state setter
    (breaker as any).forcedOpen = true;
  }
  emitStateTransitionMetric(provider, operation, "open");
}
