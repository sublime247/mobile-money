/**
 * Full-jitter exponential backoff for transient upstream telco gateway
 * errors (#2367): 502 Bad Gateway, 503 Service Unavailable, 504 Gateway
 * Timeout, and network-level timeouts. Client errors (4xx) are never
 * retried -- they indicate the request itself was rejected, not a
 * transient upstream failure, and retrying would just repeat the same
 * rejection (or, for a payment-initiating call, risk a double submission).
 *
 * Backoff formula, per the issue's acceptance criteria:
 *   delay = random_between(0, min(maxBackoffMs, baseDelayMs * 2^attempt))
 * ("full jitter" -- the delay is drawn uniformly from [0, cap], rather than
 * jittering a fixed exponential value, which better prevents synchronized
 * retry bursts across many callers backing off from the same incident).
 */

export interface RetryWithJitterOptions {
  /** Base delay in ms before the first retry (default 500ms, per #2367). */
  baseDelayMs?: number;
  /** Exponential multiplier applied per attempt (default 2.0, per #2367). */
  multiplier?: number;
  /** Upper bound on the backoff delay in ms (default 10s, per #2367). */
  maxBackoffMs?: number;
  /** Maximum number of retries after the first attempt (default 3, per #2367). */
  maxRetries?: number;
  /**
   * Decides whether `error` is transient and worth retrying. Defaults to
   * {@link isRetryableGatewayError}, which covers 502/503/504 and common
   * network-timeout error shapes.
   */
  isRetryable?: (error: unknown) => boolean;
  /** Called after a failed attempt, before the backoff sleep, when another attempt will follow. */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    error: unknown;
  }) => void | Promise<void>;
  /** Source of randomness for the jitter calculation; overridable in tests. */
  random?: () => number;
  /** Sleep implementation; overridable in tests to avoid real delays. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MULTIPLIER = 2.0;
const DEFAULT_MAX_BACKOFF_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;

const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504]);

const NETWORK_TIMEOUT_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
]);

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { response?: { status?: number }; status?: number };
  return e.response?.status ?? e.status;
}

function extractCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: string };
  return typeof e.code === "string" ? e.code : undefined;
}

/**
 * True for a transient 502/503/504 response or a network-timeout-shaped
 * error (axios `ECONNABORTED`/`ETIMEDOUT`, or a `timeout` in the message).
 * False for any other status (in particular, every 4xx) and for errors
 * with no recognizable transient signal, so unexpected failures are not
 * silently retried.
 */
export function isRetryableGatewayError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status !== undefined) {
    return TRANSIENT_GATEWAY_STATUSES.has(status);
  }

  const code = extractCode(error);
  if (code && NETWORK_TIMEOUT_CODES.has(code)) return true;

  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out/i.test(message);
}

/** Draws a full-jitter delay: uniformly random in [0, cap], where cap is the exponential backoff ceiling. */
export function computeFullJitterDelayMs(
  attempt: number,
  options: Pick<
    RetryWithJitterOptions,
    "baseDelayMs" | "multiplier" | "maxBackoffMs" | "random"
  > = {},
): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const multiplier = options.multiplier ?? DEFAULT_MULTIPLIER;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const random = options.random ?? Math.random;

  const exponential = baseDelayMs * Math.pow(multiplier, attempt);
  const cap = Math.min(maxBackoffMs, exponential);
  return Math.floor(random() * cap);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying up to `maxRetries` additional times (4 attempts
 * total by default) on a transient error, with full-jitter exponential
 * backoff between attempts. Any non-retryable error, or the final
 * retryable failure, is rethrown as-is.
 */
export async function retryWithJitter<T>(
  fn: () => Promise<T>,
  options: RetryWithJitterOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const isRetryable = options.isRetryable ?? isRetryableGatewayError;
  const sleep = options.sleep ?? defaultSleep;

  if (maxRetries < 0) {
    throw new Error("maxRetries must be >= 0");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxRetries && isRetryable(error);
      if (!canRetry) throw error;

      const delayMs = computeFullJitterDelayMs(attempt, options);
      await options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop above always either returns or throws.
  throw lastError;
}
