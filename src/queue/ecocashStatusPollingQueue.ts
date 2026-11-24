import { injectTraceContext } from "./jobTracing";
import { Queue, JobsOptions } from "bullmq";
import { queueOptions } from "./config";

/**
 * EcoCash USSD push status polling fallback (#2365).
 *
 * EcoCash's async webhook notification for a USSD push occasionally never
 * arrives, leaving a disbursement/collection stuck in "pending" with no way
 * to resolve it short of the customer contacting support. This queue backs
 * a background poller that repeatedly calls the EcoCash status endpoint
 * (EcoCashAdapter.getTransactionStatus) until the transaction reaches a
 * terminal state or the poll window expires.
 */

export const ECOCASH_STATUS_POLLING_QUEUE_NAME = "ecocash-status-polling";

export const ecocashStatusPollingQueue = new Queue<EcoCashStatusPollJobData>(
  ECOCASH_STATUS_POLLING_QUEUE_NAME,
  queueOptions,
);

export interface EcoCashStatusPollJobData {
  /** EcoCash reference/transactionId the USSD push was submitted under. */
  referenceId: string;
  /** Monotonically increasing poll attempt, starting at 1. */
  attempt: number;
  /** Epoch ms the first poll job for this reference was scheduled at. */
  startedAt: number;
}

/** Poll every 15 seconds. */
export const ECOCASH_POLL_INTERVAL_MS = Number(
  process.env.ECOCASH_POLL_INTERVAL_MS ?? 15_000,
);
/** Stop polling after 3 minutes total. */
export const ECOCASH_POLL_TIMEOUT_MS = Number(
  process.env.ECOCASH_POLL_TIMEOUT_MS ?? 3 * 60_000,
);

/**
 * Schedules the first status-poll job for a just-dispatched EcoCash USSD
 * push. Call this right after EcoCashAdapter.disburse (or a future
 * requestPayment) returns a pending/accepted result.
 */
export async function scheduleEcoCashStatusPoll(
  referenceId: string,
): Promise<void> {
  const data: EcoCashStatusPollJobData = {
    referenceId,
    attempt: 1,
    startedAt: Date.now(),
  };

  const jobOptions: JobsOptions = {
    delay: ECOCASH_POLL_INTERVAL_MS,
    removeOnComplete: true,
    removeOnFail: { age: 24 * 3600 },
    // The worker itself decides whether to re-enqueue the next poll (based
    // on elapsed time against ECOCASH_POLL_TIMEOUT_MS), so BullMQ-level
    // attempts only need to cover a single poll call failing outright.
    attempts: 1,
  };

  await ecocashStatusPollingQueue.add(
    `poll-${referenceId}`,
    injectTraceContext(data),
    jobOptions,
  );
}

/** Schedules the next poll in the sequence for the same reference. */
export async function scheduleNextEcoCashStatusPoll(
  previous: EcoCashStatusPollJobData,
): Promise<void> {
  const data: EcoCashStatusPollJobData = {
    referenceId: previous.referenceId,
    attempt: previous.attempt + 1,
    startedAt: previous.startedAt,
  };

  await ecocashStatusPollingQueue.add(`poll-${previous.referenceId}`, injectTraceContext(data), {
    delay: ECOCASH_POLL_INTERVAL_MS,
    removeOnComplete: true,
    removeOnFail: { age: 24 * 3600 },
    attempts: 1,
  });
}

export async function closeEcoCashStatusPollingQueue(): Promise<void> {
  await ecocashStatusPollingQueue.close();
}
