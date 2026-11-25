import { Counter, Histogram } from "prom-client";
import { register } from "../utils/metrics";

/**
 * Remittance and provider request metrics.
 *
 * Exposed on the shared application registry, so they appear on the
 * `/metrics` endpoint behind the existing metrics auth middleware.
 *
 *  - remittance_step_duration_seconds{corridor,step}: wall-clock time spent in
 *    each step of a remittance (e.g. provider_call, stellar_confirmation).
 *  - provider_request_errors_total{provider,status,error_code}: failed outbound
 *    provider requests, by provider, outcome status and normalised error code.
 */

export const REMITTANCE_STEP_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export const remittanceStepDurationSeconds = new Histogram({
  name: "remittance_step_duration_seconds",
  help: "Duration of each remittance processing step in seconds, labelled by corridor and step",
  labelNames: ["corridor", "step"] as const,
  buckets: REMITTANCE_STEP_BUCKETS,
  registers: [register],
});

export const providerRequestErrorsTotal = new Counter({
  name: "provider_request_errors_total",
  help: "Failed outbound provider requests, labelled by provider, status and error code",
  labelNames: ["provider", "status", "error_code"] as const,
  registers: [register],
});

const UNKNOWN_LABEL = "unknown";
const MAX_LABEL_LENGTH = 64;

/**
 * Normalise a free-form label value so unbounded input (phone numbers, error
 * text, ids) cannot explode label cardinality. Keeps `[a-z0-9_-]` only.
 */
export function normalizeMetricLabel(value: unknown, fallback = UNKNOWN_LABEL): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_LABEL_LENGTH);
  return cleaned || fallback;
}

/** Corridor label such as `ke_ug` or `ng_gh`; anything else becomes `unknown`. */
export function normalizeCorridor(value: unknown): string {
  return normalizeMetricLabel(value);
}

/**
 * Record how long a remittance step took. Negative, NaN and infinite durations
 * are discarded so a clock skew cannot corrupt the histogram.
 */
export function recordRemittanceStep(
  corridor: unknown,
  step: string,
  durationSeconds: number,
): void {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return;
  remittanceStepDurationSeconds.observe(
    { corridor: normalizeCorridor(corridor), step: normalizeMetricLabel(step) },
    durationSeconds,
  );
}

/**
 * Time an async remittance step and record it. Errors are re-thrown after the
 * duration is recorded, so instrumentation never changes control flow.
 */
export async function timeRemittanceStep<T>(
  corridor: unknown,
  step: string,
  operation: () => Promise<T>,
  now: () => number = () => Number(process.hrtime.bigint()) / 1e9,
): Promise<T> {
  const start = now();
  try {
    return await operation();
  } finally {
    recordRemittanceStep(corridor, step, now() - start);
  }
}

/** Record one failed provider request with normalised labels. */
export function recordProviderRequestError(
  provider: unknown,
  status: unknown,
  errorCode: unknown,
): void {
  providerRequestErrorsTotal.inc({
    provider: normalizeMetricLabel(provider),
    status: normalizeMetricLabel(status),
    error_code: normalizeMetricLabel(errorCode),
  });
}

/**
 * Map a provider failure (result error or thrown error) to the status and
 * error code recorded on `provider_request_errors_total`.
 */
export function classifyProviderFailure(error: unknown): {
  status: string;
  errorCode: string;
} {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/time[ d]*out|timed out|expired/i.test(message)) {
    return { status: "timeout", errorCode: "timeout" };
  }
  return { status: "failed", errorCode: "provider_error" };
}
