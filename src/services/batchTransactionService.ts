/**
 * BatchTransactionService — Batch transaction processing for deposits and withdrawals
 *
 * Provides a unified service for submitting multiple mobile-money transactions
 * in a single call, tracking per-item outcomes, and emitting structured audit
 * events for every processed item.
 *
 * Design
 * ──────
 *  - Items within a batch are processed concurrently up to `concurrency` slots
 *    (default 5) to balance throughput against provider rate-limits.
 *  - Each item carries its own idempotency key so re-running a failed batch
 *    never double-processes successful items.
 *  - A `BatchReport` is returned containing per-item outcomes plus aggregate
 *    counters; callers can persist or forward this report without further
 *    parsing.
 *
 * Supported transaction types
 * ────────────────────────────
 *  - `deposit`  — call `MobileMoneyService.initiatePayment`
 *  - `withdraw` — call `MobileMoneyService.sendPayout`
 *
 * Integration Points
 * ───────────────────
 *  - Idempotency keys are forwarded to the queue layer via `addTransactionJob`.
 *  - Progress is emitted via `EventEmitter` so callers can stream status
 *    updates (e.g. to a WebSocket or a progress bar) without polling.
 */

import { EventEmitter } from "events";
import logger from "../utils/logger";
import { MobileMoneyService } from "./mobilemoney/mobileMoneyService";
import {
  classifyProviderFailure,
  recordProviderRequestError,
  timeRemittanceStep,
} from "../monitoring/remittanceMetrics";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BatchTransactionType = "deposit" | "withdraw";

export interface BatchTransactionItem {
  /** Client-assigned idempotency key — prevents double-processing on retry. */
  idempotencyKey: string;
  /** E.164 phone number of the recipient / payer. */
  phoneNumber: string;
  /** Amount string (integer or decimal, same currency as the provider). */
  amount: string;
  /** Mobile money provider (e.g. "mtn", "airtel", "orange"). */
  provider: string;
  /** Optional caller-supplied metadata forwarded to the audit log. */
  metadata?: Record<string, unknown>;
}

export interface BatchItemOutcome {
  idempotencyKey: string;
  phoneNumber: string;
  provider: string;
  success: boolean;
  providerReference?: string;
  error?: string;
  durationMs: number;
}

export interface BatchReport {
  batchId: string;
  type: BatchTransactionType;
  submittedAt: string;
  completedAt: string;
  total: number;
  succeeded: number;
  failed: number;
  items: BatchItemOutcome[];
}

export interface BatchTransactionOptions {
  /** Max concurrent in-flight provider calls (default: 5). */
  concurrency?: number;
  /** Millisecond timeout per item before declaring it failed (default: 30 000). */
  itemTimeoutMs?: number;
}

// ── Helper ────────────────────────────────────────────────────────────────────

function generateBatchId(): string {
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `tasks` with at most `concurrency` running simultaneously. */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const current = index++;
       
      results[current] = await tasks[current]();
    }
  }

  const slots = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: slots }, worker));
  return results;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class BatchTransactionService extends EventEmitter {
  private readonly mobileMoneyService: MobileMoneyService;
  private readonly defaultConcurrency: number;
  private readonly defaultItemTimeoutMs: number;

  constructor(
    mobileMoneyService?: MobileMoneyService,
    options: BatchTransactionOptions = {},
  ) {
    super();
    this.mobileMoneyService = mobileMoneyService ?? new MobileMoneyService();
    this.defaultConcurrency = options.concurrency ?? 5;
    this.defaultItemTimeoutMs = options.itemTimeoutMs ?? 30_000;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Submit a batch of transactions.
   *
   * @param type     "deposit" or "withdraw".
   * @param items    Array of items to process.
   * @param options  Per-batch overrides for concurrency and timeout.
   * @returns A `BatchReport` with per-item outcomes and aggregate counters.
   */
  async submitBatch(
    type: BatchTransactionType,
    items: BatchTransactionItem[],
    options: BatchTransactionOptions = {},
  ): Promise<BatchReport> {
    if (!items.length) {
      throw new Error("Batch must contain at least one item");
    }

    const batchId = generateBatchId();
    const concurrency = options.concurrency ?? this.defaultConcurrency;
    const itemTimeoutMs = options.itemTimeoutMs ?? this.defaultItemTimeoutMs;
    const submittedAt = new Date().toISOString();

    logger.info(
      { batchId, type, count: items.length, concurrency },
      "[BatchTransaction] Batch submitted",
    );

    this.emit("batch:start", { batchId, type, count: items.length });

    // Deduplicate by idempotency key (last entry wins within a batch)
    const deduped = this.deduplicateItems(items);

    const tasks = deduped.map(
      (item) => () => this.processItem(batchId, type, item, itemTimeoutMs),
    );

    const outcomes = await runWithConcurrency(tasks, concurrency);

    const succeeded = outcomes.filter((o) => o.success).length;
    const failed = outcomes.filter((o) => !o.success).length;
    const completedAt = new Date().toISOString();

    const report: BatchReport = {
      batchId,
      type,
      submittedAt,
      completedAt,
      total: deduped.length,
      succeeded,
      failed,
      items: outcomes,
    };

    logger.info(
      { batchId, type, total: deduped.length, succeeded, failed },
      "[BatchTransaction] Batch complete",
    );

    this.emit("batch:complete", report);
    return report;
  }

  /**
   * Validate a batch of items before submission.
   *
   * Returns a list of validation errors. An empty array means all items are
   * valid and the batch is safe to submit.
   */
  validateBatch(items: BatchTransactionItem[]): string[] {
    const errors: string[] = [];
    const keys = new Set<string>();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const prefix = `Item[${i}] (key=${item.idempotencyKey ?? "missing"})`;

      if (!item.idempotencyKey || item.idempotencyKey.trim() === "") {
        errors.push(`${prefix}: idempotencyKey is required`);
      } else if (keys.has(item.idempotencyKey)) {
        errors.push(
          `${prefix}: duplicate idempotencyKey "${item.idempotencyKey}"`,
        );
      } else {
        keys.add(item.idempotencyKey);
      }

      if (!item.phoneNumber || !item.phoneNumber.startsWith("+")) {
        errors.push(`${prefix}: phoneNumber must be in E.164 format`);
      }

      if (
        !item.amount ||
        isNaN(Number(item.amount)) ||
        Number(item.amount) <= 0
      ) {
        errors.push(`${prefix}: amount must be a positive number`);
      }

      if (!item.provider) {
        errors.push(`${prefix}: provider is required`);
      }
    }

    return errors;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private deduplicateItems(
    items: BatchTransactionItem[],
  ): BatchTransactionItem[] {
    const seen = new Map<string, BatchTransactionItem>();
    for (const item of items) {
      seen.set(item.idempotencyKey, item);
    }
    return [...seen.values()];
  }

  private async processItem(
    batchId: string,
    type: BatchTransactionType,
    item: BatchTransactionItem,
    timeoutMs: number,
  ): Promise<BatchItemOutcome> {
    const start = Date.now();
    // Corridor is optional caller metadata; it becomes a bounded metric label.
    const corridor = item.metadata?.corridor;

    try {
      const providerCall =
        type === "deposit"
          ? this.mobileMoneyService.initiatePayment(
              item.provider,
              item.phoneNumber,
              item.amount,
            )
          : this.mobileMoneyService.sendPayout(
              item.provider,
              item.phoneNumber,
              item.amount,
            );

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Item ${item.idempotencyKey} timed out after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        ),
      );

      const result = await timeRemittanceStep(corridor, "provider_call", () =>
        Promise.race([providerCall, timeoutPromise]),
      );
      if (!result.success) {
        const { status, errorCode } = classifyProviderFailure(result.error);
        recordProviderRequestError(item.provider, status, errorCode);
      }

      const durationMs = Date.now() - start;
      const outcome: BatchItemOutcome = {
        idempotencyKey: item.idempotencyKey,
        phoneNumber: item.phoneNumber,
        provider: item.provider,
        success: result.success,
        durationMs,
        ...(result.success && result.data
          ? { providerReference: String((result.data as any)?.reference ?? "") }
          : {}),
        ...(!result.success && result.error
          ? { error: String(result.error) }
          : {}),
      };

      this.emit("item:complete", { batchId, ...outcome });
      return outcome;
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      const { status, errorCode } = classifyProviderFailure(errMsg);
      recordProviderRequestError(item.provider, status, errorCode);

      logger.error(
        { batchId, idempotencyKey: item.idempotencyKey, error: errMsg },
        "[BatchTransaction] Item failed",
      );

      const outcome: BatchItemOutcome = {
        idempotencyKey: item.idempotencyKey,
        phoneNumber: item.phoneNumber,
        provider: item.provider,
        success: false,
        error: errMsg,
        durationMs,
      };

      this.emit("item:error", { batchId, ...outcome });
      return outcome;
    }
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const batchTransactionService = new BatchTransactionService();
