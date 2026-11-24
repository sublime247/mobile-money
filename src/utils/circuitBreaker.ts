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

async function getBreakerOptions(
  name: string,
  provider: string,
): Promise<CircuitBreakerOptions> {
  let settings:
    import("../services/providerSettingsService").ProviderSettings | null =
    null;
  try {
    settings = await providerSettingsService.getProviderSettings(provider);
  } catch {
    // DB unavailable — fall back to env vars / defaults
  }

  const providerThreshold = _resolveFailureThreshold(provider);
  const volumeThreshold = settings
    ? settings.failure_threshold
    : (providerThreshold ??
      Number(process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD ?? 3));

  const providerTimeout = _resolveTimeoutMs(provider);
  const timeoutMs = settings
    ? settings.timeout_ms
    : (providerTimeout ??
      Number(process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS ?? 5_000));

  return {
    name,
    timeout: timeoutMs,
    resetTimeout: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS ?? 30_000,
    ),
    rollingCountTimeout: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_ROLLING_WINDOW_MS ?? 120_000, // 2 minutes (#1962)
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
    logger.error(
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
  const breaker = await getOrCreateCircuitBreaker<T>(
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
    try {
      breaker.shutdown();
    } catch {
      // ignore individual shutdown failures
    }
  }
  circuitBreakers.clear();
}

export function resetCircuitBreakerForProvider(provider: string): void {
  rollingBreakers.get(provider.toLowerCase())?.reset();
  for (const [key, breaker] of circuitBreakers.entries()) {
    if (key.startsWith(`${provider}:`)) {
      breaker.shutdown();
      circuitBreakers.delete(key);
    }
  }
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

  // Only attempt to reset if the circuit is open or half-open
  const state = (breaker as any).toJSON().state as {
    open: boolean;
    halfOpen: boolean;
  };
  if (!state?.open && !state?.halfOpen) {
    return false;
  }

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
    logger.error(`Failed to check health for ${provider}: ${error}`);
  }
  return false;
}

export function getCircuitBreakerCount(): number {
  return circuitBreakers.size;
}

export interface CircuitBreakerStateInfo {
  key: string;
  provider: string;
  operation: string;
  state: "OPEN" | "CLOSED" | "HALF-OPEN";
  stats: {
    failures: number;
    fallbacks: number;
    successes: number;
    rejects: number;
    fires: number;
    timeouts: number;
  };
  options: {
    volumeThreshold: number;
    errorThresholdPercentage: number;
    timeout: number;
  };
}

export function getAllCircuitBreakerStatesInfo(): CircuitBreakerStateInfo[] {
  const defaultTelcos = [
    { provider: "mtn", operation: "payment" },
    { provider: "airtel", operation: "payment" },
    { provider: "orange", operation: "payment" },
    { provider: "mpesa", operation: "payment" },
  ];

  for (const item of defaultTelcos) {
    const key = getCircuitKey(item.provider, item.operation);
    if (!circuitBreakers.has(key)) {
      void getOrCreateCircuitBreaker(item.provider, item.operation);
    }
  }

  const result: CircuitBreakerStateInfo[] = [];
  for (const [key, breaker] of circuitBreakers.entries()) {
    const parts = key.split(":");
    const provider = parts[0] || key;
    const operation = parts[1] || "default";

    const jsonState = (breaker as any).toJSON?.()?.state || {};
    let stateStr: "OPEN" | "CLOSED" | "HALF-OPEN" = "CLOSED";
    if (
      jsonState.open ||
      (breaker as any).opened ||
      (breaker as any).forcedOpen
    ) {
      stateStr = "OPEN";
    } else if (jsonState.halfOpen || (breaker as any).halfOpen) {
      stateStr = "HALF-OPEN";
    }

    const stats = (breaker as any).stats || {
      failures: 0,
      fallbacks: 0,
      successes: 0,
      rejects: 0,
      fires: 0,
      timeouts: 0,
    };

    result.push({
      key,
      provider,
      operation,
      state: stateStr,
      stats: {
        failures: stats.failures || 0,
        fallbacks: stats.fallbacks || 0,
        successes: stats.successes || 0,
        rejects: stats.rejects || 0,
        fires: stats.fires || 0,
        timeouts: stats.timeouts || 0,
      },
      options: {
        volumeThreshold: Number((breaker as any).options?.volumeThreshold ?? 3),
        errorThresholdPercentage: Number(
          (breaker as any).options?.errorThresholdPercentage ?? 50,
        ),
        timeout: Number((breaker as any).options?.timeout ?? 5000),
      },
    });
  }

  return result;
}

export async function forceCloseCircuitBreaker(
  provider: string,
  operation: string = "payment",
): Promise<void> {
  const key = getCircuitKey(provider, operation);
  const breaker = circuitBreakers.get(key);
  if (breaker) {
    if (typeof (breaker as any).close === "function") {
      (breaker as any).close();
    }
    (breaker as any).forcedOpen = false;
  }
  emitStateTransitionMetric(provider, operation, "closed");
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

// ─────────────────────────────────────────────────────────────────────────────
// Rolling-window circuit breaker state machine for telco HTTP adapters (#2571)
// ─────────────────────────────────────────────────────────────────────────────
//
//            error rate > threshold over rolling window
//   CLOSED ─────────────────────────────────────────────▶ OPEN
//     ▲                                                    │
//     │ trial succeeds                    cooldown elapsed │
//     │                                                    ▼
//     └──────────────────────────────────────────────── HALF_OPEN
//                 trial fails ──▶ OPEN (cooldown restarts)
//
// While OPEN every call fast-fails with a 503 CircuitOpenError without
// touching the network. In HALF_OPEN exactly one trial request is allowed
// through; concurrent callers keep fast-failing until it settles.

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface RollingCircuitBreakerOptions {
  /** Trip when failures / total exceeds this ratio (default 0.5 = 50%). */
  errorThreshold?: number;
  /** Rolling window over which the error rate is measured (default 30s). */
  windowMs?: number;
  /** Time spent OPEN before a HALF_OPEN trial is allowed (default 60s). */
  cooldownMs?: number;
  /**
   * Minimum calls inside the window before the error rate is evaluated, so a
   * single failure on a quiet provider cannot trip the circuit (default 5).
   */
  minimumRequests?: number;
  /** Clock override for tests. */
  now?: () => number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/** Thrown instead of calling the provider while the circuit is open. */
export class CircuitOpenError extends Error {
  readonly statusCode = 503;
  readonly code = "SERVICE_UNAVAILABLE";
  readonly provider: string;
  readonly retryAfterMs: number;

  constructor(provider: string, retryAfterMs: number) {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super(
      `${provider} is temporarily unavailable: circuit breaker is OPEN after ` +
        `repeated upstream failures. Retry in ~${seconds}s.`,
    );
    this.name = "CircuitOpenError";
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

interface Outcome {
  at: number;
  ok: boolean;
}

export class RollingCircuitBreaker {
  readonly name: string;
  private readonly errorThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly minimumRequests: number;
  private readonly now: () => number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  private state = CircuitState.CLOSED;
  private outcomes: Outcome[] = [];
  private openedAt = 0;
  private trialInFlight = false;

  constructor(name: string, options: RollingCircuitBreakerOptions = {}) {
    this.name = name;
    this.errorThreshold = options.errorThreshold ?? 0.5;
    this.windowMs = options.windowMs ?? 30_000;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.minimumRequests = options.minimumRequests ?? 5;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  /** Current state, applying the OPEN → HALF_OPEN cooldown transition lazily. */
  getState(): CircuitState {
    if (
      this.state === CircuitState.OPEN &&
      this.now() - this.openedAt >= this.cooldownMs
    ) {
      this.transition(CircuitState.HALF_OPEN);
    }
    return this.state;
  }

  /** Failure ratio over the current rolling window (0 when empty). */
  getErrorRate(): number {
    this.prune();
    if (this.outcomes.length === 0) return 0;
    const failures = this.outcomes.filter((o) => !o.ok).length;
    return failures / this.outcomes.length;
  }

  /**
   * Ask permission to send a request. Throws CircuitOpenError when the call
   * must fast-fail. Returns true when the permitted call is the HALF_OPEN trial.
   */
  acquire(): boolean {
    const state = this.getState();
    if (state === CircuitState.OPEN) {
      throw new CircuitOpenError(this.name, this.retryAfterMs());
    }
    if (state === CircuitState.HALF_OPEN) {
      if (this.trialInFlight) {
        throw new CircuitOpenError(this.name, this.retryAfterMs());
      }
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.trialInFlight = false;
      this.outcomes = [];
      this.transition(CircuitState.CLOSED);
      return;
    }
    this.push(true);
  }

  recordFailure(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.trialInFlight = false;
      this.trip();
      return;
    }
    if (this.state === CircuitState.OPEN) return;
    this.push(false);
    this.prune();
    if (
      this.outcomes.length >= this.minimumRequests &&
      this.getErrorRate() > this.errorThreshold
    ) {
      this.trip();
    }
  }

  /** Run `fn` through the breaker. `isFailure` decides which errors count. */
  async execute<T>(
    fn: () => Promise<T>,
    isFailure: (error: unknown) => boolean = () => true,
  ): Promise<T> {
    this.acquire();
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      if (isFailure(error)) this.recordFailure();
      else this.recordSuccess();
      throw error;
    }
  }

  reset(): void {
    this.outcomes = [];
    this.trialInFlight = false;
    this.transition(CircuitState.CLOSED);
  }

  private retryAfterMs(): number {
    if (this.state === CircuitState.HALF_OPEN) return this.cooldownMs;
    return Math.max(0, this.cooldownMs - (this.now() - this.openedAt));
  }

  private trip(): void {
    this.openedAt = this.now();
    this.outcomes = [];
    this.transition(CircuitState.OPEN);
  }

  private push(ok: boolean): void {
    this.outcomes.push({ at: this.now(), ok });
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    let i = 0;
    while (i < this.outcomes.length && this.outcomes[i].at <= cutoff) i++;
    if (i > 0) this.outcomes = this.outcomes.slice(i);
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    if (to === CircuitState.OPEN) {
      logger.error(
        `[circuit-breaker] ${this.name} OPEN — fast-failing for ${this.cooldownMs}ms`,
      );
    } else {
      logger.info(`[circuit-breaker] ${this.name} ${from} -> ${to}`);
    }
    this.onStateChange?.(from, to);
  }
}

const rollingBreakers = new Map<string, RollingCircuitBreaker>();

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Shared per-provider breaker used by the telco HTTP adapters. */
export function getProviderCircuitBreaker(
  provider: string,
  options: RollingCircuitBreakerOptions = {},
): RollingCircuitBreaker {
  const key = provider.toLowerCase();
  let breaker = rollingBreakers.get(key);
  if (!breaker) {
    breaker = new RollingCircuitBreaker(key, {
      errorThreshold: envNumber("TELCO_CIRCUIT_ERROR_THRESHOLD", 0.5),
      windowMs: envNumber("TELCO_CIRCUIT_WINDOW_MS", 30_000),
      cooldownMs: envNumber("TELCO_CIRCUIT_COOLDOWN_MS", 60_000),
      minimumRequests: envNumber("TELCO_CIRCUIT_MIN_REQUESTS", 5),
      ...options,
    });
    rollingBreakers.set(key, breaker);
  }
  return breaker;
}

export function resetProviderCircuitBreakers(): void {
  rollingBreakers.clear();
}
