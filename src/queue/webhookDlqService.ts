/**
 * Dead letter inspection and selective replay for failed merchant webhooks.
 *
 * Webhook deliveries that exhaust their retry attempts stay in the failed set
 * of the webhook retry queue (`webhook-callback-retries`). This service lists
 * those failures grouped by merchant, replays a selected merchant's failures
 * back into active processing, and purges dead jobs on request.
 *
 * The queue handle is injected so callers (and tests) can pass a fake. The
 * live BullMQ queue is loaded lazily, so importing this module does not open a
 * Redis connection.
 */

export const DEFAULT_WEBHOOK_DLQ_PAGE_SIZE = 200;

/** Minimal webhook job payload needed for DLQ inspection. */
export interface WebhookDlqJobData {
  webhookId?: string;
  /** Owning merchant (the user that registered the webhook). */
  userId?: string;
  url?: string;
  eventType?: string;
}

/** Minimal BullMQ job surface used by the DLQ service. */
export interface WebhookDlqJob {
  id?: string;
  data: WebhookDlqJobData;
  failedReason?: string;
  attemptsMade?: number;
  finishedOn?: number;
  timestamp: number;
  retry(
    state?: "failed",
    opts?: { resetAttemptsMade?: boolean; resetAttemptsStarted?: boolean },
  ): Promise<void>;
  remove(): Promise<void>;
}

/** Minimal BullMQ queue surface used by the DLQ service. */
export interface WebhookDlqQueue {
  getFailed(start?: number, end?: number): Promise<WebhookDlqJob[]>;
}

export interface WebhookDlqEntry {
  jobId: string;
  merchantId: string;
  webhookId?: string;
  url?: string;
  eventType?: string;
  failedReason: string;
  attemptsMade: number;
  failedAt: Date;
}

export interface WebhookDlqFilter {
  /** Only entries owned by this merchant ID. */
  merchantId?: string;
  /** Case-insensitive substring, or `/pattern/flags`, matched on the error. */
  errorMatch?: string;
  /** Maximum number of entries to return (oldest first). */
  limit?: number;
}

export interface WebhookDlqMerchantSummary {
  merchantId: string;
  count: number;
  /** Failure count per distinct error reason, most frequent first. */
  errors: Array<{ reason: string; count: number }>;
}

export interface WebhookDlqSummary {
  totalFailed: number;
  merchants: WebhookDlqMerchantSummary[];
}

export interface WebhookDlqReplayResult {
  matched: number;
  retried: number;
  skipped: number;
  errors: Array<{ jobId: string; message: string }>;
  dryRun: boolean;
}

export interface WebhookDlqPurgeResult {
  matched: number;
  removed: number;
  errors: Array<{ jobId: string; message: string }>;
  dryRun: boolean;
}

let cachedQueue: WebhookDlqQueue | undefined;

/** Resolve the live webhook retry queue on first use. */
export async function getDefaultWebhookDlqQueue(): Promise<WebhookDlqQueue> {
  if (!cachedQueue) {
    const { webhookRetryQueue } = await import("./webhookRetryQueue.js");
    cachedQueue = webhookRetryQueue as unknown as WebhookDlqQueue;
  }
  return cachedQueue;
}

function toEntry(job: WebhookDlqJob): WebhookDlqEntry {
  const data = job.data ?? {};
  return {
    jobId: String(job.id ?? ""),
    merchantId: String(data.userId ?? "unknown"),
    webhookId: data.webhookId,
    url: data.url,
    eventType: data.eventType,
    failedReason: job.failedReason ?? "unknown",
    attemptsMade: Number(job.attemptsMade ?? 0) || 0,
    failedAt: new Date(job.finishedOn ?? job.timestamp),
  };
}

function buildMatcher(pattern: string | undefined): (reason: string) => boolean {
  if (!pattern) return () => true;
  const regex = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  if (regex) {
    const re = new RegExp(regex[1], regex[2].replace("g", "") || "i");
    return (reason) => re.test(reason);
  }
  const needle = pattern.toLowerCase();
  return (reason) => reason.toLowerCase().includes(needle);
}

/** Read every failed webhook job, page by page, keeping the job handles. */
async function scanFailed(
  queue: WebhookDlqQueue,
  pageSize = DEFAULT_WEBHOOK_DLQ_PAGE_SIZE,
): Promise<WebhookDlqJob[]> {
  const all: WebhookDlqJob[] = [];
  for (let start = 0; ; start += pageSize) {
    const page = await queue.getFailed(start, start + pageSize - 1);
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

/**
 * List failed webhook jobs matching `filter`, oldest first. Returns the job
 * handles alongside the normalised entries so callers can act on them.
 */
export async function listWebhookDlq(
  filter: WebhookDlqFilter = {},
  queue?: WebhookDlqQueue,
): Promise<Array<{ entry: WebhookDlqEntry; job: WebhookDlqJob }>> {
  const source = queue ?? (await getDefaultWebhookDlqQueue());
  const matcher = buildMatcher(filter.errorMatch);
  const jobs = await scanFailed(source);

  const matched = jobs
    .map((job) => ({ entry: toEntry(job), job }))
    .filter(({ entry }) => !filter.merchantId || entry.merchantId === filter.merchantId)
    .filter(({ entry }) => matcher(entry.failedReason))
    .sort((a, b) => a.entry.failedAt.getTime() - b.entry.failedAt.getTime());

  if (filter.limit && filter.limit > 0) {
    return matched.slice(0, filter.limit);
  }
  return matched;
}

/** Group failed entries by merchant with per-error counts. */
export function summarizeWebhookDlq(entries: WebhookDlqEntry[]): WebhookDlqSummary {
  const byMerchant = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    const reasons = byMerchant.get(entry.merchantId) ?? new Map<string, number>();
    reasons.set(entry.failedReason, (reasons.get(entry.failedReason) ?? 0) + 1);
    byMerchant.set(entry.merchantId, reasons);
  }

  const merchants = [...byMerchant.entries()]
    .map(([merchantId, reasons]) => {
      const errors = [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
      return {
        merchantId,
        count: errors.reduce((sum, e) => sum + e.count, 0),
        errors,
      };
    })
    .sort((a, b) => b.count - a.count || a.merchantId.localeCompare(b.merchantId));

  return { totalFailed: entries.length, merchants };
}

/**
 * Re-queue failed webhook jobs into the active queue with their failure
 * counters reset. Jobs are matched with the same filter as `listWebhookDlq`.
 */
export async function replayWebhookDlq(
  filter: WebhookDlqFilter & { dryRun?: boolean } = {},
  queue?: WebhookDlqQueue,
): Promise<WebhookDlqReplayResult> {
  const selected = await listWebhookDlq(filter, queue);
  const result: WebhookDlqReplayResult = {
    matched: selected.length,
    retried: 0,
    skipped: 0,
    errors: [],
    dryRun: Boolean(filter.dryRun),
  };
  if (filter.dryRun) return result;

  for (const { entry, job } of selected) {
    try {
      await job.retry("failed", {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      result.retried += 1;
    } catch (err) {
      result.errors.push({
        jobId: entry.jobId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  result.skipped = result.matched - result.retried - result.errors.length;
  return result;
}

/**
 * Permanently delete failed webhook jobs matching `filter`. Destructive: the
 * CLI asks for confirmation before calling this without `--yes`.
 */
export async function purgeWebhookDlq(
  filter: WebhookDlqFilter & { dryRun?: boolean } = {},
  queue?: WebhookDlqQueue,
): Promise<WebhookDlqPurgeResult> {
  const selected = await listWebhookDlq(filter, queue);
  const result: WebhookDlqPurgeResult = {
    matched: selected.length,
    removed: 0,
    errors: [],
    dryRun: Boolean(filter.dryRun),
  };
  if (filter.dryRun) return result;

  for (const { entry, job } of selected) {
    try {
      await job.remove();
      result.removed += 1;
    } catch (err) {
      result.errors.push({
        jobId: entry.jobId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
