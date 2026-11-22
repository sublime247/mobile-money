import { Queue, Job } from "bullmq";
import { connection } from "./config";
import { Request, Response } from "express";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import logger from "../utils/logger";

/**
 * Dead Letter Queue (DLQ) for transaction processing.
 *
 * This module provides infrastructure to isolate background jobs that have
 * persistently failed after maximum retries, ensuring they do not clog
 * primary processing queues while allowing for manual inspection.
 */

export const DLQ_NAME = "transaction-dlq";

export const deadLetterQueue = new Queue(DLQ_NAME, {
  connection,
});

/**
 * Evaluates if a job has exhausted its retry attempts and moves it to the DLQ.
 * This function should be integrated into the Worker's 'failed' event listener.
 *
 * @param job The BullMQ job that failed
 */
export async function capturePersistentFailure(job: Job) {
  const maxAttempts = job.opts.attempts || 3;

  if (job.attemptsMade >= maxAttempts) {
    await deadLetterQueue.add(
      "failed-transaction-payload",
      {
        originalJobId: job.id,
        queueName: job.queueName,
        data: job.data,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        timestamp: new Date().toISOString(),
      },
      {
        // Ensure records stay in DLQ until manual cleanup/inspection
        removeOnComplete: false,
        // No retries for the DLQ entry itself
        attempts: 1,
      },
    );

    console.warn(
      `[DLQ] Job ${job.id} moved to Dead Letter Queue after ${job.attemptsMade} failed attempts.`,
    );
  }
}

const DLQ_RETENTION_DAYS = parseInt(
  process.env.DLQ_RETENTION_DAYS || "90",
  10,
);

/**
 * Removes DLQ entries older than DLQ_RETENTION_DAYS (default 90 days).
 * Safe to run repeatedly — jobs that have already been removed are skipped.
 */
export async function runDlqCleanupJob(): Promise<void> {
  const cutoffMs = DLQ_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffTimestamp = Date.now() - cutoffMs;

  const jobs = await deadLetterQueue.getJobs(["waiting"], 0, 9999);
  const stale = jobs.filter((job) => job.timestamp < cutoffTimestamp);

  if (stale.length === 0) {
    logger.info("[dlq-cleanup] No stale DLQ entries to remove.");
    return;
  }

  let removed = 0;
  let failed = 0;

  for (const job of stale) {
    try {
      await job.remove();
      removed++;
    } catch (err) {
      failed++;
      logger.warn(`[dlq-cleanup] Failed to remove DLQ entry ${job.id}:`, err);
    }
  }

  logger.info(
    `[dlq-cleanup] Cleaned ${removed} stale DLQ entries older than ${DLQ_RETENTION_DAYS} days` +
      (failed > 0 ? ` (${failed} failed to remove)` : ""),
  );
}

/**
 * Express controller for the DLQ inspection endpoint.
 * Provides visibility into failing transactions for support and engineering teams.
 */
export async function dlqInspectorHandler(req: Request, res: Response) {
  try {
    const start = parseInt(req.query.start as string) || 0;
    const limit = parseInt(req.query.limit as string) || 50;
    const transactionId = req.query.transactionId as string | undefined;

    let jobs;
    if (transactionId) {
      // Fetch a larger set then filter in memory by transactionId
      const allJobs = await deadLetterQueue.getJobs(["waiting"], 0, 9999);
      jobs = allJobs.filter(
        (job) => job.data?.data?.transactionId === transactionId,
      );
    } else {
      jobs = await deadLetterQueue.getJobs(
        ["waiting"],
        start,
        start + limit - 1,
      );
    }

    const paginated = jobs.slice(start, start + limit);
    const items = paginated.map((job) => ({
      dlqId: job.id,
      ...job.data,
    }));

    return res.status(200).json({
      success: true,
      total: jobs.length,
      count: items.length,
      start,
      limit,
      ...(transactionId && { transactionId }),
      items,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch DLQ", {
      details: message,
    });
  }
}

// ─── DLQ inspection & replay (#2448, used by `momo-cli dlq:replay`) ─────────

/** Normalised view of a DLQ entry, whichever producer wrote it. */
export interface DlqEntry {
  dlqJobId: string;
  originalJobId?: string;
  /** Queue the job originally failed on. */
  queueName: string;
  jobName?: string;
  failedReason: string;
  /** Attempts the original job made before it was dead-lettered. */
  retryCount: number;
  /** When the entry was written to the DLQ. */
  createdAt: Date;
  payload: unknown;
}

export interface DlqFilter {
  /** Only entries whose original queue name equals this. */
  queue?: string;
  /**
   * Only entries whose failure reason matches: case-insensitive substring,
   * or a regular expression when written as `/pattern/flags`.
   */
  errorMatch?: string;
  /** Maximum number of entries to return. */
  limit?: number;
}

/** Minimal BullMQ surface used here, so tests can pass plain fakes. */
export interface DlqJobLike {
  id?: string;
  data: any;
  timestamp: number;
  failedReason?: string;
  remove(): Promise<void>;
}

export interface DlqSource {
  getJobs(types: any[], start?: number, end?: number): Promise<DlqJobLike[]>;
}

export interface ReplayTargetJob {
  isFailed(): Promise<boolean>;
  getState(): Promise<string>;
  retry(state?: "failed" | "completed", opts?: { resetAttemptsMade?: boolean; resetAttemptsStarted?: boolean }): Promise<void>;
}

export interface ReplayTargetQueue {
  getJob(id: string): Promise<ReplayTargetJob | undefined | null>;
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id?: string }>;
}

export type DlqReplayStatus = "retried" | "requeued" | "skipped" | "error";

export interface DlqReplayResult {
  entry: DlqEntry;
  status: DlqReplayStatus;
  /** Job ID on the target queue after replay. */
  jobId?: string;
  message?: string;
}

const DLQ_SCAN_STATES = ["waiting", "paused", "delayed"] as const;
const DLQ_SCAN_PAGE_SIZE = 500;

function parseTimestamp(value: unknown, fallback: number): Date {
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(fallback);
}

/** Normalise a raw DLQ job into a {@link DlqEntry}. */
export function toDlqEntry(job: DlqJobLike): DlqEntry {
  const d = (job.data ?? {}) as Record<string, any>;
  return {
    dlqJobId: String(job.id ?? ""),
    originalJobId:
      d.originalJobId !== undefined && d.originalJobId !== null
        ? String(d.originalJobId)
        : undefined,
    queueName: String(d.queueName ?? "unknown"),
    jobName: d.jobName,
    failedReason: String(
      d.failedReason ?? d.errorMessage ?? job.failedReason ?? "unknown",
    ),
    retryCount: Number(d.attemptsMade ?? 0) || 0,
    createdAt: parseTimestamp(d.timestamp ?? d.failedAt, job.timestamp),
    payload: d.data ?? d.payload,
  };
}

/** Build a matcher for `--error-match`. */
export function buildErrorMatcher(
  pattern: string | undefined,
): (reason: string) => boolean {
  if (!pattern) return () => true;
  const regex = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  if (regex) {
    const re = new RegExp(regex[1], regex[2].replace("g", "") || "i");
    return (reason) => re.test(reason);
  }
  const needle = pattern.toLowerCase();
  return (reason) => reason.toLowerCase().includes(needle);
}

export function matchesDlqFilter(entry: DlqEntry, filter: DlqFilter): boolean {
  if (filter.queue && entry.queueName !== filter.queue) return false;
  return buildErrorMatcher(filter.errorMatch)(entry.failedReason);
}

/**
 * List DLQ entries (oldest first) matching `filter`, scanning the DLQ in
 * pages so large backlogs are not loaded at once.
 */
export async function listDlqEntries(
  filter: DlqFilter = {},
  source: DlqSource = deadLetterQueue as unknown as DlqSource,
): Promise<Array<{ entry: DlqEntry; job: DlqJobLike }>> {
  const limit = filter.limit && filter.limit > 0 ? filter.limit : Infinity;
  const matched: Array<{ entry: DlqEntry; job: DlqJobLike }> = [];
  const matcher = buildErrorMatcher(filter.errorMatch);

  for (let start = 0; matched.length < limit; start += DLQ_SCAN_PAGE_SIZE) {
    const page = await source.getJobs(
      [...DLQ_SCAN_STATES],
      start,
      start + DLQ_SCAN_PAGE_SIZE - 1,
    );
    for (const job of page) {
      const entry = toDlqEntry(job);
      if (filter.queue && entry.queueName !== filter.queue) continue;
      if (!matcher(entry.failedReason)) continue;
      matched.push({ entry, job });
    }
    if (page.length < DLQ_SCAN_PAGE_SIZE) break;
  }

  matched.sort((a, b) => a.entry.createdAt.getTime() - b.entry.createdAt.getTime());
  return matched.slice(0, limit === Infinity ? undefined : limit);
}

const replayQueues = new Map<string, Queue>();

/** Default target resolver: one cached BullMQ Queue handle per name. */
export function getReplayQueue(name: string): ReplayTargetQueue {
  let queue = replayQueues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection });
    replayQueues.set(name, queue);
  }
  return queue as unknown as ReplayTargetQueue;
}

export async function closeReplayQueues(): Promise<void> {
  await Promise.all([...replayQueues.values()].map((q) => q.close()));
  replayQueues.clear();
}

/**
 * Put one DLQ entry back into active processing with its failure counters
 * reset, then delete the DLQ entry.
 *
 *  - Original job still in the target queue's failed set → `retry()` it with
 *    `resetAttemptsMade` / `resetAttemptsStarted`, keeping its job ID.
 *  - Original job gone (retention expired) → add a fresh job (attemptsMade
 *    starts at 0) under the original job ID, keeping the original priority,
 *    so transaction-ID based deduplication still holds.
 *  - Original job waiting/active/completed → skipped, so a job that already
 *    succeeded is never run again (it could send a payment twice).
 */
export async function replayDlqEntry(
  entry: DlqEntry,
  job: DlqJobLike,
  resolveQueue: (name: string) => ReplayTargetQueue = getReplayQueue,
): Promise<DlqReplayResult> {
  try {
    if (entry.payload === undefined || entry.payload === null) {
      return { entry, status: "skipped", message: "DLQ entry has no job payload" };
    }

    const target = resolveQueue(entry.queueName);
    const existing = entry.originalJobId
      ? await target.getJob(entry.originalJobId)
      : null;

    let result: DlqReplayResult;
    if (existing) {
      if (!(await existing.isFailed())) {
        const state = await existing.getState();
        return {
          entry,
          status: "skipped",
          jobId: entry.originalJobId,
          message: `original job is ${state}; not replayed`,
        };
      }
      await existing.retry("failed", {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      result = { entry, status: "retried", jobId: entry.originalJobId };
    } else {
      const priority = (entry.payload as { priority?: unknown })?.priority;
      const added = await target.add(entry.jobName ?? "dlq-replay", entry.payload, {
        ...(entry.originalJobId ? { jobId: entry.originalJobId } : {}),
        ...(typeof priority === "number" && priority >= 1 && priority <= 10
          ? { priority }
          : {}),
      });
      result = { entry, status: "requeued", jobId: added.id ?? entry.originalJobId };
    }

    await job.remove();
    logger.info(
      {
        dlqJobId: entry.dlqJobId,
        originalJobId: entry.originalJobId,
        queue: entry.queueName,
        status: result.status,
      },
      "[dlq-replay] DLQ entry replayed",
    );
    return result;
  } catch (err) {
    return {
      entry,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface DlqReplayOptions extends DlqFilter {
  dryRun?: boolean;
}

export interface DlqReplaySummary {
  matched: DlqEntry[];
  results: DlqReplayResult[];
  dryRun: boolean;
}

/** List matching DLQ entries and, unless `dryRun`, replay them one by one. */
export async function replayDlqJobs(
  options: DlqReplayOptions,
  deps: {
    source?: DlqSource;
    resolveQueue?: (name: string) => ReplayTargetQueue;
  } = {},
): Promise<DlqReplaySummary> {
  const selected = await listDlqEntries(options, deps.source);
  const matched = selected.map((s) => s.entry);
  if (options.dryRun) return { matched, results: [], dryRun: true };

  const results: DlqReplayResult[] = [];
  for (const { entry, job } of selected) {
    results.push(await replayDlqEntry(entry, job, deps.resolveQueue));
  }
  return { matched, results, dryRun: false };
}
