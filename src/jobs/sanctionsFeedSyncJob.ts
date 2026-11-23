import { Queue, Worker, Job } from "bullmq";
import { connection, queueOptions } from "../queue/config";
import { syncSanctionsFeeds, SyncFeedResult } from "../compliance/feedSync";
import logger from "../utils/logger";

export const SANCTIONS_SYNC_QUEUE_NAME = "compliance-sanctions-feed-sync";

export interface SanctionsSyncJobData {
  unFeedUrl?: string;
  ofacFeedUrl?: string;
  expectedChecksum?: string;
}

export const sanctionsSyncQueue = new Queue<SanctionsSyncJobData>(
  SANCTIONS_SYNC_QUEUE_NAME,
  {
    connection,
    defaultJobOptions: queueOptions.defaultJobOptions,
  },
);

/**
 * Initializes and schedules the repeatable BullMQ cron job for daily sanctions sync
 */
export async function scheduleDailySanctionsSync(
  cronExpression = process.env.SANCTIONS_SYNC_CRON || "0 1 * * *",
): Promise<void> {
  // Remove existing repeatable jobs to prevent duplicates upon restart
  const repeatableJobs = await sanctionsSyncQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    if (job.name === "daily-sanctions-sync") {
      await sanctionsSyncQueue.removeRepeatableByKey(job.key);
    }
  }

  await sanctionsSyncQueue.add(
    "daily-sanctions-sync",
    {
      unFeedUrl:
        process.env.UN_SANCTIONS_FEED_URL ||
        "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
      ofacFeedUrl:
        process.env.OFAC_SANCTIONS_FEED_URL ||
        "https://www.treasury.gov/ofac/downloads/sdn.xml",
    },
    {
      repeat: {
        pattern: cronExpression,
      },
    },
  );

  logger.info(
    { cronExpression },
    "[BullMQ] Scheduled repeatable daily sanctions feed sync job",
  );
}

/**
 * BullMQ Worker processing sanctions feed synchronization
 */
export const sanctionsSyncWorker = new Worker<SanctionsSyncJobData, SyncFeedResult[]>(
  SANCTIONS_SYNC_QUEUE_NAME,
  async (job: Job<SanctionsSyncJobData>) => {
    logger.info(
      { jobId: job.id, data: job.data },
      "[BullMQ] Starting sanctions feed sync job execution",
    );

    const results = await syncSanctionsFeeds({
      unFeedUrl: job.data.unFeedUrl,
      ofacFeedUrl: job.data.ofacFeedUrl,
      expectedChecksum: job.data.expectedChecksum,
    });

    logger.info(
      { jobId: job.id, results },
      "[BullMQ] Sanctions feed sync job execution finished",
    );

    return results;
  },
  {
    connection,
    concurrency: 1,
  },
);

sanctionsSyncWorker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, error: err.message },
    "[BullMQ] Sanctions feed sync job failed",
  );
});

export default {
  sanctionsSyncQueue,
  sanctionsSyncWorker,
  scheduleDailySanctionsSync,
};
