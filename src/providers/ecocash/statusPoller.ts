import { EventEmitter } from "events";
import { EcoCashAdapter } from "./ecocashAdapter";
import {
  EcoCashStatusPollJobData,
  ECOCASH_POLL_TIMEOUT_MS,
  scheduleNextEcoCashStatusPoll,
} from "../../queue/ecocashStatusPollingQueue";
import { ProviderTransactionStatus } from "../../services/mobilemoney/mobileMoneyService";
import logger from "../../utils/logger";

/**
 * EcoCash USSD push status polling fallback (#2365).
 *
 * Emits "resolved" once a polled transaction reaches a terminal state
 * (completed/failed from the provider, or "timeout" when the poll window
 * elapses without a terminal state). Callers that need to update a
 * transaction record or notify a user subscribe to this emitter rather than
 * this module reaching into transaction/database code directly, keeping the
 * poller provider-focused and independent of how the rest of the codebase
 * persists transaction state.
 */
export const ecocashStatusPollEvents = new EventEmitter();

export type EcoCashPollResolution =
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  | "TIMEOUT";

export interface EcoCashStatusResolvedEvent {
  referenceId: string;
  resolution: EcoCashPollResolution;
  providerStatus: ProviderTransactionStatus;
  attempts: number;
  elapsedMs: number;
}

function toResolution(
  status: ProviderTransactionStatus,
): EcoCashPollResolution | null {
  if (status === "completed") return "SUCCESS";
  if (status === "failed") return "FAILED";
  // "pending" and "unknown" are both non-terminal from the poller's
  // perspective: "unknown" can mean a transient lookup failure (see
  // EcoCashAdapter.getTransactionStatus's catch branch), which should be
  // retried on the next poll rather than treated as a final CANCELLED.
  return null;
}

/**
 * Processes a single EcoCash status-poll job: checks the provider, and
 * either emits a terminal resolution or schedules the next poll attempt.
 * Intended to be called from the BullMQ worker's job processor.
 */
export async function processEcoCashStatusPoll(
  job: EcoCashStatusPollJobData,
  adapter: EcoCashAdapter = new EcoCashAdapter(),
  emitter: EventEmitter = ecocashStatusPollEvents,
): Promise<void> {
  const log = logger.child({ referenceId: job.referenceId });
  const elapsedMs = Date.now() - job.startedAt;

  const { status } = await adapter.getTransactionStatus(job.referenceId);
  const resolution = toResolution(status);

  if (resolution) {
    log.info(
      { resolution, attempts: job.attempt },
      "EcoCash status poll: terminal state reached",
    );
    const resolved: EcoCashStatusResolvedEvent = {
      referenceId: job.referenceId,
      resolution,
      providerStatus: status,
      attempts: job.attempt,
      elapsedMs,
    };
    emitter.emit("resolved", resolved);
    return;
  }

  if (elapsedMs >= ECOCASH_POLL_TIMEOUT_MS) {
    log.warn(
      { attempts: job.attempt, elapsedMs },
      "EcoCash status poll: timed out waiting for terminal state",
    );
    const resolved: EcoCashStatusResolvedEvent = {
      referenceId: job.referenceId,
      resolution: "TIMEOUT",
      providerStatus: status,
      attempts: job.attempt,
      elapsedMs,
    };
    emitter.emit("resolved", resolved);
    return;
  }

  log.info(
    { attempts: job.attempt, elapsedMs, status },
    "EcoCash status poll: still pending, scheduling next poll",
  );
  await scheduleNextEcoCashStatusPoll(job);
}
