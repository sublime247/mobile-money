import logger from "../utils/logger";
import { providerCircuitBreakerTransitionsTotal, providerCircuitBreakerState } from "../utils/metrics";

export type WatchdogProvider = "mtn" | "airtel" | "orange";

const LATENCY_THRESHOLD_MS = 10_000;
const CONSECUTIVE_THRESHOLD = 5;
const OPERATION = "transaction";

// Stores the last N round-trip times (ms) per provider
const latencyWindows = new Map<WatchdogProvider, number[]>();
// Tracks whether the breaker was already tripped by the watchdog (avoids duplicate trips)
const trippedByWatchdog = new Set<WatchdogProvider>();

function getWindow(provider: WatchdogProvider): number[] {
  if (!latencyWindows.has(provider)) {
    latencyWindows.set(provider, []);
  }
  return latencyWindows.get(provider)!;
}

/**
 * Record a round-trip time for a provider transaction call.
 * When 5 consecutive calls all exceed 10 s the circuit breaker is tripped.
 */
export async function recordProviderLatency(
  provider: WatchdogProvider,
  durationMs: number,
): Promise<void> {
  const window = getWindow(provider);
  window.push(durationMs);

  // Keep only the last CONSECUTIVE_THRESHOLD samples
  if (window.length > CONSECUTIVE_THRESHOLD) {
    window.shift();
  }

  if (
    window.length === CONSECUTIVE_THRESHOLD &&
    window.every((ms) => ms >= LATENCY_THRESHOLD_MS)
  ) {
    if (!trippedByWatchdog.has(provider)) {
      trippedByWatchdog.add(provider);
      logger.warn(
        { provider, samples: window, thresholdMs: LATENCY_THRESHOLD_MS },
        `Latency watchdog: ${provider} exceeded ${LATENCY_THRESHOLD_MS}ms for ${CONSECUTIVE_THRESHOLD} consecutive requests — tripping circuit breaker`,
      );
      providerCircuitBreakerTransitionsTotal.inc({ provider, operation: OPERATION, state: "open" });
      providerCircuitBreakerState.set({ provider, operation: OPERATION }, 1);

      // Dynamically trip via the circuit breaker utility
      const { tripCircuitBreaker } = await import("../utils/circuitBreaker");
      await tripCircuitBreaker(provider, OPERATION);
    }
  } else {
    // Reset the watchdog-tripped flag once a healthy latency is observed
    if (durationMs < LATENCY_THRESHOLD_MS) {
      trippedByWatchdog.delete(provider);
    }
  }
}

/** Returns the last recorded latency samples for a provider (for status reporting). */
export function getLatencyWindow(provider: WatchdogProvider): number[] {
  return [...(latencyWindows.get(provider) ?? [])];
}

/** Returns true if the watchdog has tripped the breaker for this provider. */
export function isWatchdogTripped(provider: WatchdogProvider): boolean {
  return trippedByWatchdog.has(provider);
}

/** Reset watchdog state (for testing / manual recovery). */
export function resetWatchdog(provider: WatchdogProvider): void {
  latencyWindows.delete(provider);
  trippedByWatchdog.delete(provider);
}
