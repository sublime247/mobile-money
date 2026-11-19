/**
 * Transactional Outbox Dispatcher Worker — issue #2280
 *
 * Architecture overview
 * ─────────────────────
 * Merchant webhook notifications are inserted into the `outbox_events` table
 * *inside the same database transaction* as the triggering business operation.
 * This worker runs as a background process that:
 *
 *   1. Polls for pending / failed events whose `next_attempt_at <= NOW()`.
 *   2. Claims each batch atomically using `SELECT … FOR UPDATE SKIP LOCKED`
 *      so multiple worker replicas never double-dispatch the same event.
 *   3. POSTs the JSON payload to the merchant's `webhook_url`.
 *   4. Marks events `delivered` on HTTP 2xx, or schedules an exponential
 *      back-off retry on failure (max 5 attempts before marking `dead`).
 *
 * Retry schedule (exponential back-off, seconds):
 *   attempt 1 →   30 s
 *   attempt 2 →   60 s
 *   attempt 3 →  120 s
 *   attempt 4 →  300 s
 *   attempt 5 →  600 s  → then marked `dead`
 *
 * Usage (from index.ts or a dedicated process):
 *   import { startOutboxWorker, stopOutboxWorker } from "./workers/outboxWorker";
 *   const worker = await startOutboxWorker();
 *   // on shutdown:
 *   await stopOutboxWorker(worker);
 */

import https from "https";
import type { Pool } from "pg";
import cron from "node-cron";
import http from "http";
import { URL } from "url";
import logger from "../utils/logger.js";
import { pool as defaultPool, queryWrite } from "../config/database.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = parseInt(
  process.env.OUTBOX_POLL_INTERVAL_MS ?? "5000",
  10,
);

const BATCH_SIZE = parseInt(process.env.OUTBOX_BATCH_SIZE ?? "20", 10);

const REQUEST_TIMEOUT_MS = parseInt(
  process.env.OUTBOX_REQUEST_TIMEOUT_MS ?? "10000",
  10,
);

/** Back-off schedule in seconds, indexed by zero-based attempt number. */
const BACKOFF_SECONDS = [30, 60, 120, 300, 600];

const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebhookOutboxEvent {
  id: string;
  merchant_id: string;
  webhook_url: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface OutboxWorkerHandle {
  stop: () => void;
}

// ---------------------------------------------------------------------------
// HTTP delivery helper
// ---------------------------------------------------------------------------

interface DeliveryResult {
  statusCode: number;
  responseTimeMs: number;
  error?: string;
}

/**
 * POST `payload` as JSON to `webhookUrl`.
 * Resolves with `{ statusCode, responseTimeMs }` on any HTTP response.
 * Rejects with an `Error` on network / timeout failures.
 */
export function deliverWebhookPayload(
  webhookUrl: string,
  payload: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<DeliveryResult> {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    let url: URL;

    try {
      url = new URL(webhookUrl);
    } catch {
      return reject(new Error(`Invalid webhook URL: ${webhookUrl}`));
    }

    const body = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "mobile-money-outbox/1.0",
      },
    };

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      // Drain the response body to free the socket
      res.on("data", () => {});
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          responseTimeMs: Date.now() - startMs,
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    });

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the next batch of events ready for dispatch and lock them atomically.
 * Uses `SKIP LOCKED` so concurrent worker instances skip rows already locked
 * by a sibling.
 */
async function claimBatch(): Promise<WebhookOutboxEvent[]> {
  const result = await queryWrite<WebhookOutboxEvent>(
    `UPDATE outbox_events
        SET status = 'processing',
            updated_at = NOW()
      WHERE id IN (
        SELECT id FROM outbox_events
         WHERE status IN ('pending', 'failed')
           AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT $1
           FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id,
        merchant_id,
        webhook_url,
        event_type,
        payload,
        attempts,
        max_attempts`,
    [BATCH_SIZE],
  );

  return result.rows;
}

async function markDelivered(
  id: string,
  httpStatus: number,
  responseTimeMs: number,
): Promise<void> {
  await queryWrite(
    `UPDATE outbox_events
        SET status           = 'delivered',
            delivered_at     = NOW(),
            last_attempt_at  = NOW(),
            last_http_status = $2,
            response_time_ms = $3,
            updated_at       = NOW()
      WHERE id = $1`,
    [id, httpStatus, responseTimeMs],
  );
}

async function scheduleRetry(
  id: string,
  attempts: number,
  httpStatus: number | null,
  errorMessage: string,
): Promise<void> {
  const nextAttempt = attempts + 1;
  const isDead = nextAttempt >= MAX_ATTEMPTS;
  const backoffSecs = BACKOFF_SECONDS[attempts] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1];

  await queryWrite(
    `UPDATE outbox_events
        SET status           = $2,
            attempts         = $3,
            last_attempt_at  = NOW(),
            next_attempt_at  = NOW() + ($4 || ' seconds')::INTERVAL,
            last_http_status = $5,
            last_error       = $6,
            updated_at       = NOW()
      WHERE id = $1`,
    [
      id,
      isDead ? "dead" : "failed",
      nextAttempt,
      backoffSecs,
      httpStatus,
      errorMessage.slice(0, 2000), // guard against oversized error messages
    ],
  );
}

// ---------------------------------------------------------------------------
// Core dispatch loop
// ---------------------------------------------------------------------------

async function processBatch(): Promise<void> {
  let batch: WebhookOutboxEvent[];

  try {
    batch = await claimBatch();
  } catch (err) {
    logger.error(err, "[OutboxWorker] Failed to claim batch from DB");
    return;
  }

  if (batch.length === 0) return;

  logger.info({ count: batch.length }, "[OutboxWorker] Processing batch");

  await Promise.allSettled(
    batch.map(async (event) => {
      let result: DeliveryResult;

      try {
        result = await deliverWebhookPayload(event.webhook_url, {
          event_id: event.id,
          event_type: event.event_type,
          merchant_id: event.merchant_id,
          ...event.payload,
        });
      } catch (networkErr: any) {
        logger.warn(
          { eventId: event.id, error: networkErr.message },
          "[OutboxWorker] Network error — scheduling retry",
        );
        await scheduleRetry(
          event.id,
          event.attempts,
          null,
          networkErr.message ?? "Network error",
        ).catch((dbErr) =>
          logger.error(dbErr, "[OutboxWorker] Failed to schedule retry"),
        );
        return;
      }

      const isSuccess =
        result.statusCode >= 200 && result.statusCode < 300;

      if (isSuccess) {
        logger.info(
          {
            eventId: event.id,
            statusCode: result.statusCode,
            responseTimeMs: result.responseTimeMs,
          },
          "[OutboxWorker] Event delivered",
        );
        await markDelivered(
          event.id,
          result.statusCode,
          result.responseTimeMs,
        ).catch((dbErr) =>
          logger.error(dbErr, "[OutboxWorker] Failed to mark delivered"),
        );
      } else {
        logger.warn(
          {
            eventId: event.id,
            statusCode: result.statusCode,
            attempts: event.attempts,
          },
          "[OutboxWorker] Non-2xx response — scheduling retry",
        );
        await scheduleRetry(
          event.id,
          event.attempts,
          result.statusCode,
          `HTTP ${result.statusCode}`,
        ).catch((dbErr) =>
          logger.error(dbErr, "[OutboxWorker] Failed to schedule retry"),
        );
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the outbox dispatcher background loop.
 *
 * Returns a handle with a `stop()` method for graceful shutdown.
 */
export async function startOutboxWorker(): Promise<OutboxWorkerHandle> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      await processBatch();
    } catch (err) {
      logger.error(err, "[OutboxWorker] Unhandled error in tick");
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
  }

  logger.info(
    { pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE },
    "[OutboxWorker] Starting",
  );

  // Kick off the first tick immediately
  timer = setTimeout(tick, 0);

  return {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      logger.info("[OutboxWorker] Stopped");
    },
  };
}

/**
 * Gracefully stop a running outbox worker.
 */
export async function stopOutboxWorker(
  handle: OutboxWorkerHandle,
): Promise<void> {
  handle.stop();
}

export interface OutboxEvent {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: any;
  status: string;
  attempts: number;
  max_attempts: number;
  last_attempt_at: Date | null;
  next_attempt_at: Date;
  error_message: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OutboxWorkerOptions {
  pool?: Pool;
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  pruneAfterHours?: number;
}

export interface OutboxWorkerSummary {
  processed: number;
  published: number;
  failed: number;
  pruned: number;
  durationMs: number;
}

/**
 * Outbox worker for transactional event publishing.
 * 
 * This worker implements the Transactional Outbox pattern to ensure atomic
 * consistency between database updates and external message brokers. Domain
 * events are written to the outbox table within the same DB transaction as the
 * business logic, then this worker polls and publishes them with at-least-once
 * delivery guarantee.
 */
export class OutboxWorker {
  private pool: Pool;
  private pollIntervalMs: number;
  private batchSize: number;
  private maxAttempts: number;
  private retryDelayMs: number;
  private pruneAfterHours: number;
  private scheduledTask: cron.ScheduledTask | null = null;
  private isRunning = false;

  constructor(options: OutboxWorkerOptions = {}) {
    this.pool = options.pool ?? defaultPool;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? 60000;
    this.pruneAfterHours = options.pruneAfterHours ?? 24;
  }

  /**
   * Process pending outbox events by publishing them to external message brokers.
   * This method is called periodically by the cron scheduler or can be invoked manually.
   */
  public async process(): Promise<OutboxWorkerSummary> {
    if (this.isRunning) {
      logger.info("[OutboxWorker] Previous processing cycle still in progress. Skipping.");
      return { processed: 0, published: 0, failed: 0, pruned: 0, durationMs: 0 };
    }

    this.isRunning = true;
    const startedAt = Date.now();
    let processed = 0;
    let published = 0;
    let failed = 0;
    let pruned = 0;

    try {
      // 1. Fetch pending events ready for processing
      const events = await this.fetchPendingEvents();

      for (const event of events) {
        processed++;
        const result = await this.publishEvent(event);

        if (result.success) {
          await this.markAsPublished(event.id);
          published++;
        } else {
          await this.markAsFailed(event.id, result.error);
          failed++;
        }
      }

      // 2. Prune old published events
      pruned = await this.pruneOldEvents();

      logger.info(
        { processed, published, failed, pruned },
        "[OutboxWorker] Processing cycle completed",
      );
    } catch (error: any) {
      logger.error({ error: error.message }, "[OutboxWorker] Error during processing cycle");
      throw error;
    } finally {
      this.isRunning = false;
    }

    const durationMs = Date.now() - startedAt;
    return { processed, published, failed, pruned, durationMs };
  }

  /**
   * Fetch pending events that are ready for processing.
   */
  private async fetchPendingEvents(): Promise<OutboxEvent[]> {
    const result = await this.pool.query<OutboxEvent>(
      `SELECT id, event_type, aggregate_type, aggregate_id, payload, status, 
              attempts, max_attempts, last_attempt_at, next_attempt_at, 
              error_message, published_at, created_at, updated_at
       FROM outbox_events
       WHERE status IN ('pending', 'failed')
         AND next_attempt_at <= CURRENT_TIMESTAMP
       ORDER BY next_attempt_at ASC
       LIMIT $1`,
      [this.batchSize],
    );

    return result.rows;
  }

  /**
   * Publish a single event to the external message broker.
   * This is a placeholder implementation - in production, this would integrate
   * with your actual message broker (RabbitMQ, NATS, Kafka, etc.).
   */
  private async publishEvent(event: OutboxEvent): Promise<{ success: boolean; error?: string }> {
    try {
      // Update status to processing before attempting publish
      await this.pool.query(
        `UPDATE outbox_events
         SET status = 'processing', 
             last_attempt_at = CURRENT_TIMESTAMP,
             attempts = attempts + 1
         WHERE id = $1`,
        [event.id],
      );

      // TODO: Integrate with actual message broker
      // For now, we simulate successful publishing
      // In production, you would:
      // - Publish to RabbitMQ/NATS/Kafka based on event_type
      // - Handle broker-specific errors
      // - Implement idempotency keys if needed

      logger.info(
        {
          eventId: event.id,
          eventType: event.event_type,
          aggregateType: event.aggregate_type,
          aggregateId: event.aggregate_id,
        },
        "[OutboxWorker] Publishing event",
      );

      // Simulate successful publish
      return { success: true };
    } catch (error: any) {
      logger.error(
        {
          eventId: event.id,
          eventType: event.event_type,
          error: error.message,
        },
        "[OutboxWorker] Failed to publish event",
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Mark an event as successfully published.
   */
  private async markAsPublished(eventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox_events
       SET status = 'published',
           published_at = CURRENT_TIMESTAMP,
           next_attempt_at = NULL
       WHERE id = $1`,
      [eventId],
    );
  }

  /**
   * Mark an event as failed and schedule retry.
   */
  private async markAsFailed(eventId: string, errorMessage: string): Promise<void> {
    const event = await this.pool.query<OutboxEvent>(
      `SELECT attempts, max_attempts FROM outbox_events WHERE id = $1`,
      [eventId],
    );

    if (event.rows.length === 0) {
      return;
    }

    const { attempts, max_attempts } = event.rows[0];

    if (attempts >= max_attempts) {
      // Max attempts reached, mark as permanently failed
      await this.pool.query(
        `UPDATE outbox_events
         SET status = 'failed',
             error_message = $2,
             next_attempt_at = NULL
         WHERE id = $1`,
        [eventId, errorMessage],
      );
      logger.warn(
        { eventId, attempts: attempts, maxAttempts: max_attempts },
        "[OutboxWorker] Event max attempts reached, marked as failed",
      );
    } else {
      // Schedule retry with exponential backoff
      const delayMs = this.retryDelayMs * Math.pow(2, attempts);
      const nextAttemptAt = new Date(Date.now() + delayMs);

      await this.pool.query(
        `UPDATE outbox_events
         SET status = 'failed',
             error_message = $2,
             next_attempt_at = $3
         WHERE id = $1`,
        [eventId, errorMessage, nextAttemptAt],
      );
    }
  }

  /**
   * Prune old published events to prevent table bloat.
   */
  private async pruneOldEvents(): Promise<number> {
    const cutoffDate = new Date(Date.now() - this.pruneAfterHours * 60 * 60 * 1000);

    const result = await this.pool.query(
      `DELETE FROM outbox_events
       WHERE status = 'published'
         AND published_at < $1`,
      [cutoffDate],
    );

    const prunedCount = result.rowCount || 0;
    if (prunedCount > 0) {
      logger.info({ count: prunedCount }, "[OutboxWorker] Pruned old published events");
    }

    return prunedCount;
  }

  /**
   * Start periodic execution of the outbox worker using node-cron.
   * Default schedule is every 5 seconds.
   */
  public startCron(schedule = process.env.OUTBOX_WORKER_CRON || "*/5 * * * * *"): cron.ScheduledTask {
    if (this.scheduledTask) {
      return this.scheduledTask;
    }

    this.scheduledTask = cron.schedule(schedule, async () => {
      try {
        await this.process();
      } catch (err: any) {
        logger.error({ error: err.message }, "[OutboxWorker] Cron run encountered error");
      }
    });

    logger.info({ schedule }, "[OutboxWorker] Cron scheduler registered");
    return this.scheduledTask;
  }

  /**
   * Stop the active cron schedule.
   */
  public stopCron(): void {
    if (this.scheduledTask) {
      this.scheduledTask.stop();
      this.scheduledTask = null;
    }
    logger.info("[OutboxWorker] Cron scheduler stopped");
  }
}

export const outboxWorker = new OutboxWorker();

/**
 * Top-level job execution handler for centralized scheduler.
 */
export async function runOutboxWorkerJob(): Promise<void> {
  await outboxWorker.process();
}
