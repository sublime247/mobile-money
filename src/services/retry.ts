/**
 * Exponential backoff retries for transient failures (network, timeouts, 5xx).
 * Permanent errors (validation, insufficient funds, etc.) are not retried.
 */

const TRANSIENT_HINTS =
  /econnreset|etimedout|econnrefused|enotfound|network|socket|timeout|temporar|unavailable|429|502|503|504|fetch failed|aborted/i;

const PERMANENT_HINTS =
  /invalid|insufficient|bad request|malformed|unauthorized|forbidden|not found|wrong\s+number|duplicate|rejected|bad\s+request|400|401|403|404|422/i;

export function isTransientError(error: unknown, provider?: string): boolean {
  let innerError = error;
  if (
    error &&
    typeof error === "object" &&
    "originalError" in error &&
    (error as any).originalError
  ) {
    innerError = (error as any).originalError;
  }

  if (
    provider &&
    innerError &&
    typeof innerError === "object" &&
    "response" in innerError
  ) {
    const status = (innerError as any).response?.status;
    if (status) {
      const p = provider.toLowerCase();
      if (p === "mtn") {
        if (
          status === 400 ||
          status === 401 ||
          status === 404 ||
          status === 409
        )
          return false;
      } else if (p === "airtel" || p === "orange") {
        if (status === 400 || status === 401) return false;
      }
      if (status >= 500 || status === 429) return true;
    }
  }

  const msg =
    error instanceof Error
      ? `${error.message} ${(error as NodeJS.ErrnoException).code ?? ""} ${innerError instanceof Error ? innerError.message : String(innerError)}`
      : String(error);

  if (PERMANENT_HINTS.test(msg)) return false;
  return TRANSIENT_HINTS.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WithRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  provider?: string;
  /** Called after a failed attempt when another attempt will follow */
  onRetry?: (info: { attempt: number; error: unknown }) => void | Promise<void>;
}

/**
 * Runs `fn` up to `maxAttempts` times. After attempt `k` fails with a transient
 * error, waits `baseDelayMs * 2^(k-1)` ms before the next attempt.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions,
): Promise<T> {
  const { maxAttempts, baseDelayMs, onRetry } = options;
  if (maxAttempts < 1) throw new Error("maxAttempts must be at least 1");

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const canRetry =
        isTransientError(error, options.provider) && attempt < maxAttempts;
      if (!canRetry) throw error;

      console.warn(
        `[retry] transient failure attempt ${attempt}/${maxAttempts}, backing off`,
        error instanceof Error ? error.message : error,
      );
      await onRetry?.({ attempt, error });
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
