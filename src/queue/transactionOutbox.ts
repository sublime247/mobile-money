import logger from "../utils/logger";
import { queryWrite } from "../config/database";

/**
 * PostgreSQL outbox for transaction enqueues.
 *
 * Transaction jobs normally go straight onto the BullMQ queue (Redis). When
 * Redis is unreachable - connection dropped, reconnecting, or the offline
 * command queue stalling - the job is persisted to `outbox_events` instead, so
 * an in-flight transaction is never lost. A relay loop replays the pending
 * rows onto the queue once Redis is back; it keeps retrying on its own, so no
 * manual intervention is needed after an outage.
 *
 * Replays use the transaction id as the BullMQ `jobId`, so a job that did make
 * it into Redis before the connection dropped is de-duplicated, not doubled.
 */

export const TRANSACTION_ENQUEUE_EVENT = "transaction.enqueue";
export const TRANSACTION_AGGREGATE_TYPE = "transaction";

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * BullMQ keeps commands in an offline queue while Redis is down, so `add()`
 * hangs rather than failing. Bound the wait so callers fail over to the outbox.
 */
export const ENQUEUE_TIMEOUT_MS = parsePositiveInt(
  process.env.TRANSACTION_ENQUEUE_TIMEOUT_MS,
  3000,
);
export const OUTBOX_RELAY_INTERVAL_MS = parsePositiveInt(
  process.env.TRANSACTION_OUTBOX_INTERVAL_MS,
  5000,
);
const OUTBOX_BATCH_SIZE = parsePositiveInt(
  process.env.TRANSACTION_OUTBOX_BATCH_SIZE,
  50,
);
/** A row stuck in `processing` this long belongs to a crashed relay. */
const STALE_PROCESSING_SECONDS = 120;
const RETRY_BACKOFF_SECONDS = 5;

export interface OutboxJobOptions {
  priority?: number;
  delay?: number;
  jobId?: string;
}

export interface OutboxRow<T = unknown> {
  id: string;
  aggregate_id: string;
  payload: { data: T; options?: OutboxJobOptions };
  attempts: number;
  max_attempts: number;
}

export type Dispatch<T> = (
  data: T,
  options?: OutboxJobOptions,
) => Promise<{ id: string | undefined }>;

export interface OutboxStore {
  /** Persist an enqueue request; no-op if one is already outstanding for the id. */
  insert(transactionId: string, payload: unknown): Promise<void>;
  /** Atomically claim ready rows (status -> processing). */
  claim(limit: number): Promise<OutboxRow[]>;
  markPublished(id: string): Promise<void>;
  /** Return a row to the queue without counting an attempt (Redis was down). */
  release(id: string, delaySeconds: number): Promise<void>;
  /** Count a failed attempt; dead-letters the row once attempts are exhausted. */
  markFailed(id: string, error: string): Promise<void>;
}

export const postgresOutboxStore: OutboxStore = {
  async insert(transactionId, payload) {
    await queryWrite(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       SELECT $1, $2, $3, $4::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM outbox_events
           WHERE event_type = $1
             AND aggregate_id = $3
             AND status IN ('pending', 'processing', 'failed')
             AND next_attempt_at IS NOT NULL
        )`,
      [
        TRANSACTION_ENQUEUE_EVENT,
        TRANSACTION_AGGREGATE_TYPE,
        transactionId,
        JSON.stringify(payload),
      ],
    );
  },

  async claim(limit) {
    const result = await queryWrite<OutboxRow>(
      `UPDATE outbox_events
          SET status = 'processing'
        WHERE id IN (
          SELECT id FROM outbox_events
           WHERE event_type = $1
             AND (
               (status IN ('pending', 'failed')
                 AND next_attempt_at <= CURRENT_TIMESTAMP)
               OR (status = 'processing'
                 AND updated_at < CURRENT_TIMESTAMP - ($3::text || ' seconds')::interval)
             )
           ORDER BY created_at ASC
           LIMIT $2
             FOR UPDATE SKIP LOCKED
        )
        RETURNING id, aggregate_id, payload, attempts, max_attempts`,
      [TRANSACTION_ENQUEUE_EVENT, limit, STALE_PROCESSING_SECONDS],
    );
    return result.rows;
  },

  async markPublished(id) {
    await queryWrite(
      `UPDATE outbox_events
          SET status = 'published',
              published_at = CURRENT_TIMESTAMP,
              last_attempt_at = CURRENT_TIMESTAMP,
              next_attempt_at = NULL,
              error_message = NULL
        WHERE id = $1`,
      [id],
    );
  },

  async release(id, delaySeconds) {
    await queryWrite(
      `UPDATE outbox_events
          SET status = 'pending',
              next_attempt_at = CURRENT_TIMESTAMP + ($2::text || ' seconds')::interval
        WHERE id = $1`,
      [id, delaySeconds],
    );
  },

  async markFailed(id, error) {
    await queryWrite(
      `UPDATE outbox_events
          SET status = 'failed',
              attempts = attempts + 1,
              last_attempt_at = CURRENT_TIMESTAMP,
              error_message = $2,
              next_attempt_at = CASE
                WHEN attempts + 1 >= max_attempts THEN NULL
                ELSE CURRENT_TIMESTAMP
                     + (($3::int * POWER(2, attempts))::text || ' seconds')::interval
              END
        WHERE id = $1`,
      [id, error.slice(0, 2000), RETRY_BACKOFF_SECONDS],
    );
  },
};

// ---------------------------------------------------------------------------
// Redis failure detection
// ---------------------------------------------------------------------------

export class EnqueueTimeoutError extends Error {
  readonly code = "ENQUEUE_TIMEOUT";
  constructor(timeoutMs: number) {
    super(`Queue did not accept the job within ${timeoutMs}ms`);
    this.name = "EnqueueTimeoutError";
  }
}

const REDIS_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "NR_CLOSED",
  "ENQUEUE_TIMEOUT",
]);

const REDIS_ERROR_MESSAGE =
  /connection is closed|stream isn't writeable|socket (closed|already closed)|the client is closed|client closed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|max(imum)? retries per request|connection timeout|redis (is )?(unavailable|down)/i;

/** True when the failure means Redis is unreachable (as opposed to a bad job). */
export function isRedisUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, name, message } = err as {
    code?: string;
    name?: string;
    message?: string;
  };
  if (code && REDIS_ERROR_CODES.has(code)) return true;
  if (name === "ClientClosedError" || name === "ConnectionTimeoutError") {
    return true;
  }
  return typeof message === "string" && REDIS_ERROR_MESSAGE.test(message);
}

export function withEnqueueTimeout<T>(
  work: Promise<T>,
  timeoutMs: number = ENQUEUE_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new EnqueueTimeoutError(timeoutMs)),
      timeoutMs,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Enqueue with outbox fallback
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  id: string | undefined;
  /** True when Redis was unavailable and the job was parked in PostgreSQL. */
  outboxed?: boolean;
}

/**
 * Dispatch a transaction job; if Redis is unavailable, persist it to the
 * outbox instead of failing the request. Non-Redis errors (e.g. backpressure,
 * validation) are rethrown untouched.
 */
export async function enqueueWithOutboxFallback<
  T extends { transactionId: string },
>(
  dispatch: Dispatch<T>,
  data: T,
  options?: OutboxJobOptions,
  store: OutboxStore = postgresOutboxStore,
): Promise<EnqueueResult> {
  try {
    return await withEnqueueTimeout(dispatch(data, options));
  } catch (err) {
    if (!isRedisUnavailableError(err)) throw err;

    logger.warn(
      { transactionId: data.transactionId, error: (err as Error).message },
      "[transaction-outbox] Redis unavailable - persisting enqueue to PostgreSQL outbox",
    );
    await store.insert(data.transactionId, { data, options });
    return { id: data.transactionId, outboxed: true };
  }
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

export interface DrainSummary {
  published: number;
  failed: number;
  /** Rows handed back untouched because Redis is still down. */
  deferred: number;
  redisDown: boolean;
}

/** Replay claimed outbox rows onto the queue. Safe to call concurrently. */
export async function drainTransactionOutbox<
  T extends { transactionId: string },
>(
  dispatch: Dispatch<T>,
  store: OutboxStore = postgresOutboxStore,
  batchSize: number = OUTBOX_BATCH_SIZE,
): Promise<DrainSummary> {
  const summary: DrainSummary = {
    published: 0,
    failed: 0,
    deferred: 0,
    redisDown: false,
  };

  const rows = (await store.claim(batchSize)) as OutboxRow<T>[];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      await withEnqueueTimeout(
        dispatch(row.payload.data, {
          ...row.payload.options,
          jobId: row.aggregate_id,
        }),
      );
      await store.markPublished(row.id);
      summary.published++;
    } catch (err) {
      if (isRedisUnavailableError(err)) {
        // Redis is still down: hand this and every unprocessed row back
        // without burning attempts, and wait for the next tick.
        summary.redisDown = true;
        for (const pending of rows.slice(i)) {
          await store.release(pending.id, RETRY_BACKOFF_SECONDS);
          summary.deferred++;
        }
        break;
      }
      logger.error(
        { outboxId: row.id, transactionId: row.aggregate_id, err },
        "[transaction-outbox] Replay failed",
      );
      await store.markFailed(row.id, (err as Error).message ?? String(err));
      summary.failed++;
    }
  }

  if (summary.published > 0) {
    logger.info(summary, "[transaction-outbox] Replayed outboxed transactions");
  }
  return summary;
}

let relayTimer: NodeJS.Timeout | null = null;
let relayInFlight = false;

/**
 * Start the relay loop. It polls forever, so processing resumes by itself the
 * moment Redis reconnects.
 */
export function startTransactionOutboxRelay<
  T extends { transactionId: string },
>(
  dispatch: Dispatch<T>,
  options: { intervalMs?: number; store?: OutboxStore } = {},
): void {
  if (relayTimer) return;
  const intervalMs = options.intervalMs ?? OUTBOX_RELAY_INTERVAL_MS;

  const tick = async () => {
    if (relayInFlight) return;
    relayInFlight = true;
    try {
      await drainTransactionOutbox(dispatch, options.store);
    } catch (err) {
      // e.g. PostgreSQL briefly unavailable - the next tick retries.
      logger.error({ err }, "[transaction-outbox] Relay tick failed");
    } finally {
      relayInFlight = false;
    }
  };

  relayTimer = setInterval(() => void tick(), intervalMs);
  relayTimer.unref();
  logger.info({ intervalMs }, "[transaction-outbox] Relay started");
}

export function stopTransactionOutboxRelay(): void {
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }
}
