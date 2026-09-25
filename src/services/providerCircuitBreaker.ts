//! Provider circuit breaker facade (#1962).
//
// A full circuit breaker already exists in `../utils/circuitBreaker.ts`
// (opossum-based: OPEN/HALF-OPEN/CLOSED, a configurable error-rate
// threshold defaulting to 50%, and a rolling window now defaulting to 2
// minutes per this issue) and is already wired into the deposit/payout
// dispatcher (`mobileMoneyService_impl.js`'s `executeProviderOperation`)
// with failover across a configured provider chain.
//
// This module does not duplicate that logic. It is a thin facade that:
//   - exposes read-only helpers to check whether a provider's breaker is
//     currently open, for callers that want to avoid attempting a call at
//     all (e.g. to skip straight to a secondary provider), and
//   - builds the friendly "maintenance-style" message and error shape a
//     caller should surface to the end user when every provider in the
//     failover chain has an open breaker and the request cannot proceed,
//     mirroring the existing `PROVIDER_MAINTENANCE` abort shape
//     (`mobileMoneyService.ts`'s `resolveProviderForMaintenance`).

import {
  getAllCircuitBreakerStatesInfo,
  isCircuitBreakerOpenError,
  type CircuitBreakerStateInfo,
} from "../utils/circuitBreaker";

export type CircuitBreakerState = "OPEN" | "CLOSED" | "HALF-OPEN";

const DEFAULT_OPERATION = "requestPayment";

function findState(
  provider: string,
  operation: string,
): CircuitBreakerStateInfo | undefined {
  return getAllCircuitBreakerStatesInfo().find(
    (info) => info.provider === provider && info.operation === operation,
  );
}

/**
 * The current breaker state for a provider+operation.
 * A provider with no recorded calls yet is treated as CLOSED (available) —
 * the breaker only opens after enough real failures are observed.
 */
export function getProviderCircuitState(
  provider: string,
  operation: string = DEFAULT_OPERATION,
): CircuitBreakerState {
  return findState(provider, operation)?.state ?? "CLOSED";
}

/**
 * Whether a provider's breaker is currently OPEN (tripped) for the given
 * operation. HALF-OPEN counts as available, since opossum itself is already
 * mid-recovery-test at that point and will let a probe request through.
 */
export function isProviderCircuitOpen(
  provider: string,
  operation: string = DEFAULT_OPERATION,
): boolean {
  return getProviderCircuitState(provider, operation) === "OPEN";
}

export interface ProviderCircuitOpenError {
  code: "PROVIDER_CIRCUIT_OPEN";
  provider: string;
  operation: string;
  message: string;
}

/**
 * Build the friendly, user-facing response for when a provider's circuit
 * breaker is open and no provider in the failover chain could be used
 * instead. Shape mirrors the existing `PROVIDER_MAINTENANCE` abort
 * response in `mobileMoneyService.ts`, so callers already handling that
 * shape (queue workers, controllers) need no separate branch.
 */
export function buildProviderCircuitOpenResponse(
  provider: string,
  operation: string = DEFAULT_OPERATION,
): { success: false; provider: string; error: ProviderCircuitOpenError } {
  return {
    success: false,
    provider,
    error: {
      code: "PROVIDER_CIRCUIT_OPEN",
      provider,
      operation,
      message: `Provider ${provider} is temporarily unavailable due to repeated failures. Please try again shortly.`,
    },
  };
}

/**
 * Whether a caught error represents an unresolved circuit-breaker-open
 * failure — i.e. the underlying `executeWithCircuitBreaker` call rejected
 * with `EOPENBREAKER` and no fallback succeeded either. Re-exported here so
 * callers only need to import from this facade rather than reaching into
 * `../utils/circuitBreaker` directly.
 */
export { isCircuitBreakerOpenError };
