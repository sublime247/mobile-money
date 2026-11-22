import { Worker, Job } from "bullmq";
import { queueOptions } from "./config";
import {
  ECOCASH_STATUS_POLLING_QUEUE_NAME,
  EcoCashStatusPollJobData,
} from "./ecocashStatusPollingQueue";
import { processEcoCashStatusPoll } from "../providers/ecocash/statusPoller";
import logger from "../utils/logger";
import { withJobTrace } from "./jobTracing";

let worker: Worker | null = null;

export function startEcoCashStatusPollingWorker(): void {
  if (worker) return;

  worker = new Worker(
    ECOCASH_STATUS_POLLING_QUEUE_NAME,
    async (job: Job<EcoCashStatusPollJobData>) => {
      try {
        await withJobTrace(
          "queue.ecocash-status-poll.process",
          job.data,
          () => processEcoCashStatusPoll(job.data),
          {
            "messaging.system": "bullmq",
            "messaging.destination.name": ECOCASH_STATUS_POLLING_QUEUE_NAME,
            "messaging.message.id": job.id ?? "",
          },
        );
      } catch (error) {
        logger.error(
          error,
          `EcoCash status poll failed for reference ${job.data.referenceId} (attempt ${job.data.attempt})`,
        );
        throw error;
      }
    },
    queueOptions,
  );

  worker.on("failed", (job, err) => {
    logger.error(err, `EcoCash status polling job ${job?.id} failed`);
  });

  logger.info("EcoCash status polling worker started");
}

export async function closeEcoCashStatusPollingWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("EcoCash status polling worker closed");
  }
}
