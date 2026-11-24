import type { BackoffStrategy, JobsOptions, MinimalJob } from "bullmq";
import logger from "../utils/logger";
import {
  computeFullJitterDelay,
  exponentialCeiling,
  JitterBackoffOptions,
  RandomSource,
} from "../utils/jitterBackoff";

/**
 * BullMQ retry configuration for outbound webhook notifications.
 *
 * Retries use exponential backoff with full jitter (see `utils/jitterBackoff`)
 * so merchant endpoints recovering from an outage are not hit by every queued
 * delivery at once.
 *
 * Defaults: 8 attempts, 5 minute base delay, 12 hour cap. The worst case for
 * the 7 retries is 10m + 20m + 40m + 80m + 160m + 320m + 640m ≈ 21h, so every
 * delivery is settled (delivered or dead-lettered) within 24 hours.
 */

/** Custom BullMQ backoff type handled by `webhookBackoffStrategy`. */
export const WEBHOOK_BACKOFF_TYPE = "webhook-full-jitter";

export const DEFAULT_WEBHOOK_RETRY_ATTEMPTS = 8;
export const DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS = 5 * 60 * 1000;
export const DEFAULT_WEBHOOK_RETRY_MAX_DELAY_MS = 12 * 60 * 60 * 1000;

export interface WebhookRetryConfig extends JitterBackoffOptions {
  attempts: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegative(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Read retry configuration from the environment:
 *  - WEBHOOK_RETRY_MAX_ATTEMPTS  (default 8)
 *  - WEBHOOK_RETRY_BASE_DELAY_MS (default 300000 = 5 min)
 *  - WEBHOOK_RETRY_MAX_DELAY_MS  (default 43200000 = 12 h)
 */
export function getWebhookRetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): WebhookRetryConfig {
  const baseDelayMs = nonNegative(
    env.WEBHOOK_RETRY_BASE_DELAY_MS,
    DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    nonNegative(env.WEBHOOK_RETRY_MAX_DELAY_MS, DEFAULT_WEBHOOK_RETRY_MAX_DELAY_MS),
  );
  return {
    attempts: positiveInt(
      env.WEBHOOK_RETRY_MAX_ATTEMPTS,
      DEFAULT_WEBHOOK_RETRY_ATTEMPTS,
    ),
    baseDelayMs,
    maxDelayMs,
  };
}

/** Job options for an outbound webhook delivery job. */
export function buildWebhookRetryJobOptions(
  config: WebhookRetryConfig = getWebhookRetryConfig(),
): Pick<JobsOptions, "attempts" | "backoff"> {
  return {
    attempts: config.attempts,
    backoff: { type: WEBHOOK_BACKOFF_TYPE },
  };
}

export interface RetryAuditRecord {
  jobId?: string;
  webhookId?: unknown;
  eventType?: unknown;
  /** 1-based index of the retry about to be scheduled. */
  attempt: number;
  maxAttempts?: number;
  delayMs: number;
  ceilingMs: number;
  error?: string;
}

/**
 * Write the retry index and computed delay to the delivery audit trail: the
 * structured application log and the job's own BullMQ log (visible in the
 * queue dashboard alongside the delivery history).
 */
export function recordRetryAudit(
  record: RetryAuditRecord,
  job?: Pick<MinimalJob, "log">,
): void {
  logger.info(record, "[webhook-queue] Scheduled webhook delivery retry");
  if (job && typeof job.log === "function") {
    job.log(JSON.stringify({ type: "retry_scheduled", ...record })).catch(() => {
      // Audit logging must never fail the retry itself.
    });
  }
}

/**
 * Build the BullMQ `backoffStrategy` for webhook workers. BullMQ resolves its
 * built-in types ("fixed", "exponential") itself and only calls this for
 * custom types, i.e. jobs enqueued with `WEBHOOK_BACKOFF_TYPE`.
 */
export function createWebhookBackoffStrategy(
  config: WebhookRetryConfig = getWebhookRetryConfig(),
  random: RandomSource = Math.random,
): BackoffStrategy {
  return (attemptsMade, _type, err, job) => {
    const delayMs = computeFullJitterDelay(attemptsMade, config, random);
    const data = (job?.data ?? {}) as Record<string, unknown>;
    recordRetryAudit(
      {
        jobId: job?.id,
        webhookId: data.webhookId,
        eventType: data.eventType,
        attempt: attemptsMade,
        maxAttempts: job?.opts?.attempts,
        delayMs,
        ceilingMs: exponentialCeiling(attemptsMade, config),
        error: err?.message,
      },
      job,
    );
    return delayMs;
  };
}

/** Worker `settings` that install the full-jitter strategy. */
export function webhookWorkerSettings(
  config: WebhookRetryConfig = getWebhookRetryConfig(),
): { backoffStrategy: BackoffStrategy } {
  return { backoffStrategy: createWebhookBackoffStrategy(config) };
}
