import { Job } from "bullmq";
import { sendAlert } from "../services/alertService";
import logger from "../utils/logger";

/**
 * Dead Letter Queue (DLQ) retry-limit notifier (#2374).
 *
 * When a job in a critical payment/payout queue exhausts all of its
 * automated retry attempts and is about to move to the Dead Letter Queue
 * (see src/queue/dlq.ts's capturePersistentFailure), this dispatches a
 * formatted alert to the operational Slack/Discord channel via the existing
 * retryable webhook client (src/services/alertService.ts - already handles
 * per-provider rate limiting, missing-webhook-URL skip, and Slack+Discord
 * fan-out).
 *
 * This module does NOT duplicate alertService's HTTP/retry logic; it only
 * adds DLQ-specific formatting (job id, transaction reference, error stack,
 * retry count) on top of it.
 */

export interface DlqNotificationContext {
  /** Name of the BullMQ queue the job belongs to, used as alertService's rate-limit key. */
  queueName: string;
}

/**
 * True once `job.attemptsMade` has reached the job's configured maximum -
 * i.e. this failure is the one that sends the job to the DLQ, not an
 * intermediate retry. Mirrors capturePersistentFailure's own check in
 * src/queue/dlq.ts so the two stay in lock-step (a job is only ever
 * reported to the DLQ and alerted on at the same instant).
 */
export function isFinalAttempt(job: Job): boolean {
  const maxAttempts = job.opts.attempts || 3;
  return job.attemptsMade >= maxAttempts;
}

/**
 * Extracts a human-meaningful transaction reference from a job's data,
 * covering the differently-shaped payloads used by this codebase's queues
 * (transactionId, reference number, or DLQ-wrapped originalJobId).
 */
function extractTransactionReference(job: Job): string {
  const data = (job.data ?? {}) as Record<string, unknown>;
  const reference =
    (data.transactionId as string | undefined) ??
    (data.referenceNumber as string | undefined) ??
    (data.reference as string | undefined) ??
    (data.originalJobId as string | undefined);
  return reference ?? job.id ?? "unknown";
}

function extractErrorStack(error: Error): string {
  // Slack/Discord payloads are size-limited; truncate defensively so a huge
  // stack trace can never cause the whole webhook delivery to be rejected.
  const stack = error.stack ?? error.message;
  const MAX_STACK_LENGTH = 1500;
  return stack.length > MAX_STACK_LENGTH
    ? `${stack.slice(0, MAX_STACK_LENGTH)}\n... (truncated)`
    : stack;
}

/**
 * Dispatches a DLQ retry-limit-exceeded alert for a job that has just
 * exhausted its retries. Safe to call unconditionally from a worker's
 * `failed` handler - it is a no-op (returns without dispatching) for any
 * failure that is not the final attempt.
 *
 * Never throws: a notification failure must not affect job processing or
 * the DLQ capture it accompanies.
 */
export async function notifyDlqRetryLimitExceeded(
  job: Job | undefined,
  error: Error,
  context: DlqNotificationContext,
): Promise<void> {
  if (!job || !isFinalAttempt(job)) {
    return;
  }

  try {
    await sendAlert({
      provider: context.queueName,
      error: `Job exhausted all retry attempts and moved to the Dead Letter Queue: ${error.message}`,
      severity: "critical",
      transactionId: extractTransactionReference(job),
      meta: {
        jobId: job.id ?? "unknown",
        queueName: context.queueName,
        retryCount: job.attemptsMade,
        errorStack: extractErrorStack(error),
      },
    });
  } catch (notifyError) {
    logger.error(
      { jobId: job.id, queueName: context.queueName, notifyError },
      "[dlqNotifier] Failed to dispatch DLQ retry-limit-exceeded alert",
    );
  }
}
