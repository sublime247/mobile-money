import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";
import { redisClient } from "../config/redis";
import { ERROR_CODES } from "../constants/errorCodes";
import { AppError, createError } from "../middleware/errorHandler";
import { calculateTransactionPriority } from "./priority";

/**
 * Redis memory backpressure for transaction ingestion.
 *
 * A background loop reads `INFO memory` and flips an in-process flag with
 * hysteresis: ingestion pauses once usage exceeds the high watermark (80%) and
 * only resumes once it falls below the low watermark (70%), which prevents
 * flapping around a single threshold. While paused, non-critical work is
 * rejected with HTTP 503 + Retry-After; critical (high priority) work is still
 * admitted so large/VIP payments are not dropped.
 */

const parseNumber = (value: string | undefined, fallback: number): number => {
  const n = value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const BACKPRESSURE_HIGH_WATERMARK = parseNumber(
  process.env.QUEUE_BACKPRESSURE_HIGH_WATERMARK,
  0.8,
);
export const BACKPRESSURE_LOW_WATERMARK = Math.min(
  parseNumber(process.env.QUEUE_BACKPRESSURE_LOW_WATERMARK, 0.7),
  BACKPRESSURE_HIGH_WATERMARK,
);
export const BACKPRESSURE_CHECK_INTERVAL_MS = parseNumber(
  process.env.QUEUE_BACKPRESSURE_CHECK_INTERVAL_MS,
  5000,
);
/** Jobs with a priority value <= this (1 = highest) bypass backpressure. */
export const BACKPRESSURE_CRITICAL_PRIORITY = parseNumber(
  process.env.QUEUE_BACKPRESSURE_CRITICAL_PRIORITY,
  2,
);
/** Fallback capacity when Redis has no `maxmemory` configured. */
const MAX_MEMORY_OVERRIDE_BYTES = parseNumber(
  process.env.QUEUE_BACKPRESSURE_MAX_MEMORY_BYTES,
  0,
);

interface BackpressureState {
  active: boolean;
  usageRatio: number | null;
  usedMemoryBytes: number | null;
  maxMemoryBytes: number | null;
  lastCheckedAt: Date | null;
  pausedAt: Date | null;
}

const state: BackpressureState = {
  active: false,
  usageRatio: null,
  usedMemoryBytes: null,
  maxMemoryBytes: null,
  lastCheckedAt: null,
  pausedAt: null,
};

let timer: NodeJS.Timeout | null = null;
let checkInFlight = false;

/** Parse the `key:value` lines of a Redis INFO section. */
export function parseRedisInfo(info: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of info.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Compute used/capacity memory from an INFO memory payload. Capacity is
 * `maxmemory` when set, otherwise the configured override, otherwise the
 * host's `total_system_memory`. Returns null when capacity is unknown.
 */
export function computeMemoryUsage(
  info: string,
): { used: number; max: number; ratio: number } | null {
  const fields = parseRedisInfo(info);
  const used = Number(fields.used_memory);
  if (!Number.isFinite(used)) return null;

  const candidates = [
    Number(fields.maxmemory),
    MAX_MEMORY_OVERRIDE_BYTES,
    Number(fields.total_system_memory),
  ];
  const max = candidates.find((v) => Number.isFinite(v) && v > 0);
  if (!max) return null;

  return { used, max, ratio: used / max };
}

/**
 * Apply the watermark hysteresis to a usage ratio and update module state.
 * Exported for tests and for callers that obtain the ratio themselves.
 */
export function evaluateBackpressure(ratio: number): boolean {
  if (!state.active && ratio > BACKPRESSURE_HIGH_WATERMARK) {
    state.active = true;
    state.pausedAt = new Date();
    logger.warn(
      { usageRatio: ratio, threshold: BACKPRESSURE_HIGH_WATERMARK },
      "[queue-backpressure] Redis memory above high watermark; pausing non-critical ingestion",
    );
  } else if (state.active && ratio < BACKPRESSURE_LOW_WATERMARK) {
    state.active = false;
    state.pausedAt = null;
    logger.info(
      { usageRatio: ratio, threshold: BACKPRESSURE_LOW_WATERMARK },
      "[queue-backpressure] Redis memory below low watermark; resuming ingestion",
    );
  }
  return state.active;
}

/** Run one health check against Redis. Never throws. */
export async function checkRedisMemory(): Promise<void> {
  if (checkInFlight) return;
  checkInFlight = true;
  try {
    const info = await redisClient.info("memory");
    const usage = computeMemoryUsage(info);
    state.lastCheckedAt = new Date();
    if (!usage) return;

    state.usedMemoryBytes = usage.used;
    state.maxMemoryBytes = usage.max;
    state.usageRatio = usage.ratio;
    evaluateBackpressure(usage.ratio);
  } catch (error) {
    // Keep the previous state: a transient INFO failure should neither
    // trigger nor release backpressure.
    logger.error({ error }, "[queue-backpressure] Failed to read Redis INFO memory");
  } finally {
    checkInFlight = false;
  }
}

export function startRedisBackpressureMonitor(): void {
  if (timer) return;
  void checkRedisMemory();
  timer = setInterval(() => void checkRedisMemory(), BACKPRESSURE_CHECK_INTERVAL_MS);
  timer.unref();
  logger.info(
    {
      high: BACKPRESSURE_HIGH_WATERMARK,
      low: BACKPRESSURE_LOW_WATERMARK,
      intervalMs: BACKPRESSURE_CHECK_INTERVAL_MS,
    },
    "[queue-backpressure] Redis memory monitor started",
  );
}

export function stopRedisBackpressureMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function isBackpressureActive(): boolean {
  return state.active;
}

export function getBackpressureState(): Readonly<BackpressureState> {
  return { ...state };
}

/** Test helper: reset module state. */
export function resetBackpressureState(): void {
  state.active = false;
  state.usageRatio = null;
  state.usedMemoryBytes = null;
  state.maxMemoryBytes = null;
  state.lastCheckedAt = null;
  state.pausedAt = null;
}

/** Suggested client wait: a few check intervals, at least 5 seconds. */
export function getRetryAfterSeconds(): number {
  return Math.max(5, Math.ceil((BACKPRESSURE_CHECK_INTERVAL_MS * 3) / 1000));
}

export function isCriticalPriority(priority: number): boolean {
  return priority <= BACKPRESSURE_CRITICAL_PRIORITY;
}

export interface BackpressureError extends AppError {
  retryAfterSeconds: number;
}

export function createBackpressureError(): BackpressureError {
  const retryAfterSeconds = getRetryAfterSeconds();
  const error = createError(
    ERROR_CODES.SERVICE_UNAVAILABLE,
    "Transaction ingestion is temporarily paused due to high system load. Please retry shortly.",
    { reason: "redis_memory_backpressure", retryAfterSeconds },
  ) as BackpressureError;
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

/**
 * Express guard for transaction-creating routes. Runs before any database
 * write so a rejected request leaves no orphaned pending transaction.
 */
export function redisBackpressureGuard(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  if (!state.active) return next();

  // Only the amount is considered: client-supplied tier/priority fields must
  // not be able to bypass backpressure.
  const body = (req.body ?? {}) as { amount?: unknown };
  const priority = calculateTransactionPriority({
    amount: body.amount as string | number | undefined,
  });
  if (isCriticalPriority(priority)) return next();

  return next(createBackpressureError());
}
