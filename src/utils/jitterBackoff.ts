/**
 * Exponential backoff with "full jitter".
 *
 *   delay = random_between(0, min(max_delay, base_delay * 2 ** attempt))
 *
 * Spreading every retry uniformly across the whole exponential window keeps
 * a fleet of failed deliveries from hammering a recovering endpoint at the
 * same instant (the thundering-herd problem), while the exponential ceiling
 * still backs off quickly from a sustained outage.
 *
 * See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */

export interface JitterBackoffOptions {
  /** Base delay in milliseconds (`base_delay`). */
  baseDelayMs: number;
  /** Upper bound for any single delay in milliseconds (`max_delay`). */
  maxDelayMs: number;
}

/** Source of uniform random numbers in `[0, 1)`; injectable for tests. */
export type RandomSource = () => number;

function assertOptions({ baseDelayMs, maxDelayMs }: JitterBackoffOptions): void {
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError("baseDelayMs must be a finite, non-negative number");
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError("maxDelayMs must be a finite, non-negative number");
  }
}

/**
 * The exponential ceiling for `attempt`: `min(max_delay, base_delay * 2 ** attempt)`.
 * Negative or fractional attempts are clamped/floored to a whole attempt index.
 */
export function exponentialCeiling(
  attempt: number,
  options: JitterBackoffOptions,
): number {
  assertOptions(options);
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  // `2 ** n` overflows to Infinity for large n, which `Math.min` caps cleanly.
  return Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** n);
}

/**
 * Full-jitter delay for `attempt`, an integer in `[0, ceiling]`, never above
 * `maxDelayMs`.
 */
export function computeFullJitterDelay(
  attempt: number,
  options: JitterBackoffOptions,
  random: RandomSource = Math.random,
): number {
  const ceiling = exponentialCeiling(attempt, options);
  // Clamp the random source defensively so a misbehaving RNG can never push
  // the delay outside [0, ceiling].
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.min(ceiling, Math.floor(r * (ceiling + 1)));
}
