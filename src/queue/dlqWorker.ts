/**
 * DLQ Automated Replay and Alert Worker
 *
 * Monitors the dead-letter queue depth on a configurable interval.
 * When the number of failed jobs exceeds the threshold it fires a
 * Telegram/Slack alert and, when auto-replay is enabled, retries the
 * oldest failed jobs by moving them back onto the originating queue.
 *
 * Env vars:
 *   DLQ_MONITOR_INTERVAL_MS      – poll interval (default 60 000)
 *   DLQ_ALERT_THRESHOLD          – job count that triggers an alert (default 5)
 *   DLQ_AUTO_REPLAY              – set "true" to enable automatic replay
 *   DLQ_AUTO_REPLAY_BATCH_SIZE   – max jobs replayed per cycle (default 10)
 *   DLQ_REPLAY_ERROR_CODES       – comma-separated error substrings to replay
 *                                  (default: replays all when empty)
 *   TELEGRAM_BOT_TOKEN           – Telegram bot token for alerts
 *   TELEGRAM_CHAT_ID             – Telegram chat / channel ID
 *   SLACK_ALERT_WEBHOOK_URL      – existing Slack webhook (reuses alertService)
 */

import axios from "axios";
import { Queue, Job } from "bullmq";
import { deadLetterQueue, DLQ_NAME } from "./dlq";
import { transactionQueue, TRANSACTION_QUEUE_NAME } from "./transactionQueue";
import { connection } from "./config";
import { sendAlert } from "../services/alertService";
import logger from "../utils/logger";

// ─── Config ────────────────────────────────────────────────────────────────

const MONITOR_INTERVAL_MS = Number(
  process.env.DLQ_MONITOR_INTERVAL_MS ?? 60_000,
);
const ALERT_THRESHOLD = Number(process.env.DLQ_ALERT_THRESHOLD ?? 5);
const AUTO_REPLAY = process.env.DLQ_AUTO_REPLAY === "true";
const AUTO_REPLAY_BATCH = Number(
  process.env.DLQ_AUTO_REPLAY_BATCH_SIZE ?? 10,
);
const REPLAY_ERROR_CODES: string[] = process.env.DLQ_REPLAY_ERROR_CODES
  ? process.env.DLQ_REPLAY_ERROR_CODES.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

// ─── Telegram alerting ─────────────────────────────────────────────────────

async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      },
      { timeout: 5_000 },
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[dlq-worker] Telegram alert delivery failed",
    );
  }
}

async function fireAlerts(depth: number, stalledCount: number): Promise<void> {
  const msg =
    `🚨 *DLQ Alert*\n` +
    `Dead-letter queue depth has reached *${depth}* job(s)` +
    (stalledCount > 0 ? ` (${stalledCount} stalled)` : "") +
    `.\nReview: \`GET /api/admin/dlq\``;

  await Promise.all([
    sendTelegramAlert(msg),
    sendAlert(
      {
        provider: "dlq",
        error: `DLQ depth exceeded threshold: ${depth} jobs (threshold: ${ALERT_THRESHOLD})`,
        severity: depth >= ALERT_THRESHOLD * 3 ? "critical" : "error",
        meta: { depth, stalledCount, threshold: ALERT_THRESHOLD },
      },
      { cooldownMs: MONITOR_INTERVAL_MS * 5 },
    ),
  ]);
}

// ─── Error-code filter ────────────────────────────────────────────────────

function jobMatchesReplayFilter(job: Job): boolean {
  if (REPLAY_ERROR_CODES.length === 0) return true;
  const reason = String(job.data?.failedReason ?? job.failedReason ?? "").toLowerCase();
  return REPLAY_ERROR_CODES.some((code) =>
    reason.includes(code.toLowerCase()),
  );
}

// ─── Replay logic ──────────────────────────────────────────────────────────

/**
 * Moves a DLQ entry back onto the originating queue.
 * Returns true when the job was successfully re-queued.
 */
export async function replayDlqJob(dlqJob: Job): Promise<boolean> {
  try {
    const original = dlqJob.data;
    if (!original?.data) {
      logger.warn(
        { dlqJobId: dlqJob.id },
        "[dlq-worker] DLQ entry missing original job data, skipping replay",
      );
      return false;
    }

    // Resolve target queue — default to the transaction queue
    const targetQueueName: string =
      original.queueName ?? TRANSACTION_QUEUE_NAME;

    let targetQueue: Queue;
    if (targetQueueName === TRANSACTION_QUEUE_NAME) {
      targetQueue = transactionQueue;
    } else {
      // Lazily open a Queue handle for less common queue names
      targetQueue = new Queue(targetQueueName, { connection });
    }

    await targetQueue.add("dlq-replay", original.data, {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
    });

    await dlqJob.remove();

    logger.info(
      {
        dlqJobId: dlqJob.id,
        originalJobId: original.originalJobId,
        targetQueue: targetQueueName,
      },
      "[dlq-worker] DLQ job replayed",
    );
    return true;
  } catch (err) {
    logger.error(
      { dlqJobId: dlqJob.id, err },
      "[dlq-worker] Failed to replay DLQ job",
    );
    return false;
  }
}

// ─── Monitor cycle ─────────────────────────────────────────────────────────

let lastAlertAt = 0;

async function runMonitorCycle(): Promise<void> {
  try {
    const jobs = await deadLetterQueue.getJobs(["waiting"], 0, 9999);
    const depth = jobs.length;

    // Count stalled: jobs that have been in the DLQ for more than 24 h
    const stalledThreshold = Date.now() - 24 * 60 * 60 * 1000;
    const stalledCount = jobs.filter((j) => j.timestamp < stalledThreshold).length;

    logger.debug({ depth, stalledCount }, "[dlq-worker] DLQ monitor cycle");

    if (depth >= ALERT_THRESHOLD) {
      // Respect a per-cycle cooldown so we don't spam alerts every minute
      const now = Date.now();
      if (now - lastAlertAt >= MONITOR_INTERVAL_MS * 4) {
        await fireAlerts(depth, stalledCount);
        lastAlertAt = now;
      }

      if (AUTO_REPLAY) {
        const candidates = jobs
          .filter((j) => jobMatchesReplayFilter(j))
          .slice(0, AUTO_REPLAY_BATCH);

        let replayed = 0;
        for (const job of candidates) {
          const ok = await replayDlqJob(job);
          if (ok) replayed++;
        }

        if (replayed > 0) {
          logger.info(
            { replayed, depth },
            "[dlq-worker] Auto-replayed DLQ jobs",
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "[dlq-worker] Monitor cycle failed");
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startDlqMonitor(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(runMonitorCycle, MONITOR_INTERVAL_MS);
  // Run one cycle immediately so the first alert isn't delayed a full interval
  void runMonitorCycle();
  logger.info(
    { intervalMs: MONITOR_INTERVAL_MS, threshold: ALERT_THRESHOLD },
    "[dlq-worker] DLQ monitor started",
  );
}

export function stopDlqMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
