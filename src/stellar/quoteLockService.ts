/**
 * SEP-38 firm quote execution lock (#2557).
 *
 * A firm quote must settle exactly once. During volatile markets a client
 * (or a retrying proxy) can fire several conversion requests for the same
 * quote ID within milliseconds; without coordination each request could
 * debit fiat or credit crypto independently.
 *
 * This module grants exclusive execution rights on a quote ID via a Redis
 * `SET key token NX PX ttl` lock. Release is a compare-and-delete Lua script
 * so a request can only ever release the lock it holds — never one that
 * another instance acquired after this one's TTL lapsed.
 *
 * When Redis is disconnected the lock degrades to a per-process in-memory
 * map so a Redis outage still serialises executions within one instance
 * instead of letting them run unguarded.
 */

import { randomUUID } from "crypto";
import { redisClient } from "../config/redis";
import logger from "../utils/logger";

export const QUOTE_LOCK_PREFIX = "sep38:quote-lock:";

/** Default lock TTL — long enough for an on-chain settlement round-trip. */
export const DEFAULT_QUOTE_LOCK_TTL_MS = parseInt(
  process.env.SEP38_QUOTE_LOCK_TTL_MS || "30000",
  10,
);

/** Deletes the key only if it still holds our token (atomic). */
const RELEASE_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export interface QuoteLock {
  quoteId: string;
  token: string;
  key: string;
  expiresAt: number;
  /** Where the lock lives — "redis" normally, "memory" during a Redis outage. */
  backend: "redis" | "memory";
}

/** Thrown when another request already holds the execution lock for a quote. */
export class QuoteLockConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "QUOTE_EXECUTION_IN_PROGRESS";

  constructor(readonly quoteId: string) {
    super(`Quote ${quoteId} is already being executed`);
    this.name = "QuoteLockConflictError";
  }
}

export const isQuoteLockConflictError = (
  error: unknown,
): error is QuoteLockConflictError => error instanceof QuoteLockConflictError;

const memoryLocks = new Map<string, { token: string; expiresAt: number }>();

export function quoteLockKey(quoteId: string): string {
  return `${QUOTE_LOCK_PREFIX}${quoteId}`;
}

function redisOnline(): boolean {
  return Boolean(redisClient?.isOpen);
}

function tryAcquireMemory(key: string, token: string, ttlMs: number): boolean {
  const now = Date.now();
  const existing = memoryLocks.get(key);
  if (existing && existing.expiresAt > now) return false;
  memoryLocks.set(key, { token, expiresAt: now + ttlMs });
  return true;
}

function releaseMemory(key: string, token: string): boolean {
  const existing = memoryLocks.get(key);
  if (!existing || existing.token !== token) return false;
  memoryLocks.delete(key);
  return true;
}

/**
 * Attempts to take the execution lock for `quoteId` without waiting.
 * Returns the lock on success, or `null` when another holder has it.
 */
export async function acquireQuoteLock(
  quoteId: string,
  ttlMs: number = DEFAULT_QUOTE_LOCK_TTL_MS,
): Promise<QuoteLock | null> {
  if (!quoteId) throw new Error("quoteId is required to acquire a quote lock");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`Invalid quote lock TTL: ${ttlMs}`);
  }

  const key = quoteLockKey(quoteId);
  const token = randomUUID();
  const expiresAt = Date.now() + ttlMs;

  if (redisOnline()) {
    const reply = await redisClient.set(key, token, {
      condition: "NX",
      expiration: { type: "PX", value: ttlMs },
    });
    if (reply !== "OK") return null;
    return { quoteId, token, key, expiresAt, backend: "redis" };
  }

  logger.warn(
    { quoteId },
    "[QuoteLock] Redis unavailable — falling back to in-process quote lock",
  );
  if (!tryAcquireMemory(key, token, ttlMs)) return null;
  return { quoteId, token, key, expiresAt, backend: "memory" };
}

/**
 * Releases a lock previously returned by {@link acquireQuoteLock}. Returns
 * `true` if this call removed the lock, `false` if it had already expired or
 * been taken over by another holder. Never throws: a failed release is
 * logged and the TTL reclaims the key.
 */
export async function releaseQuoteLock(lock: QuoteLock): Promise<boolean> {
  try {
    if (lock.backend === "memory") {
      return releaseMemory(lock.key, lock.token);
    }
    const removed = await redisClient.eval(RELEASE_IF_OWNER, {
      keys: [lock.key],
      arguments: [lock.token],
    });
    return Number(removed) === 1;
  } catch (err) {
    logger.error(
      { err, quoteId: lock.quoteId },
      "[QuoteLock] Failed to release quote lock — it will expire via TTL",
    );
    return false;
  }
}

/**
 * Runs `fn` while holding the exclusive execution lock for `quoteId`.
 *
 * - Throws {@link QuoteLockConflictError} (HTTP 409) immediately if another
 *   request holds the lock — no waiting, so a duplicate request cannot
 *   execute after the first one finishes.
 * - Releases the lock as soon as `fn` resolves or throws.
 */
export async function withQuoteLock<T>(
  quoteId: string,
  fn: (lock: QuoteLock) => Promise<T>,
  ttlMs: number = DEFAULT_QUOTE_LOCK_TTL_MS,
): Promise<T> {
  const lock = await acquireQuoteLock(quoteId, ttlMs);
  if (!lock) {
    logger.warn({ quoteId }, "[QuoteLock] Concurrent execution attempt rejected");
    throw new QuoteLockConflictError(quoteId);
  }

  try {
    return await fn(lock);
  } finally {
    await releaseQuoteLock(lock);
  }
}

/** Test helper: clears the in-memory fallback locks. */
export function _resetQuoteLocks(): void {
  memoryLocks.clear();
}
