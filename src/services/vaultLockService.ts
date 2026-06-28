/**
 * Vault Distributed Lock Service
 *
 * Prevents double-spending and concurrent vault balance adjustments by
 * acquiring a per-vault Redis lock (Redlock-style) before any mutation.
 *
 * Algorithm (single-node, production-safe):
 *   1. SET vault:lock:<vaultId> <token> NX PX <ttl>
 *      NX = only set if key does not exist
 *      PX = TTL in milliseconds (auto-expires on crash)
 *   2. Execute the critical section (DB update)
 *   3. DEL vault:lock:<vaultId> only when our token matches
 *      (Lua script makes check-and-delete atomic)
 *
 * Lock token is a cryptographically random UUID so a crashed process
 * cannot accidentally release a lock it does not own.
 *
 * Usage:
 *   const result = await vaultLockService.withLock(vaultId, async () => {
 *     await vaultModel.updateBalance(vaultId, newBalance, client);
 *   });
 */

import crypto from 'crypto';
import { redisClient } from '../config/redis';
import logger from '../utils/logger';

const LOCK_TTL_MS  = 5_000;   // 5 seconds — enough for a single DB round-trip
const RETRY_DELAY  = 100;     // ms between retry attempts
const MAX_RETRIES  = 30;      // 30 x 100ms = 3 second max wait

// Lua script: release lock ONLY if the token matches (atomic compare-and-delete)
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

const lockKey = (vaultId: string): string => `vault:lock:${vaultId}`;

export class VaultLockError extends Error {
  constructor(public readonly vaultId: string) {
    super(`Could not acquire lock on vault ${vaultId} within ${MAX_RETRIES * RETRY_DELAY}ms`);
    this.name = 'VaultLockError';
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Acquire a per-vault distributed lock.
 * Returns the opaque lock token on success, null on failure.
 */
async function acquireLock(vaultId: string): Promise<string | null> {
  const token = crypto.randomUUID();
  const key   = lockKey(vaultId);
  const redis  = redisClient as any;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // SET key token NX PX ttl — returns 'OK' on success, null if already locked
    const result = await redis.set(key, token, { NX: true, PX: LOCK_TTL_MS });
    if (result === 'OK') {
      logger.debug({ vaultId, token, attempt }, '[vault-lock] acquired');
      return token;
    }
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY);
    }
  }
  return null;
}

/**
 * Release the lock atomically via Lua script.
 * A lock owned by another token (i.e. we expired) is left untouched.
 */
async function releaseLock(vaultId: string, token: string): Promise<void> {
  try {
    const redis = redisClient as any;
    await redis.eval(RELEASE_SCRIPT, { keys: [lockKey(vaultId)], arguments: [token] });
    logger.debug({ vaultId, token }, '[vault-lock] released');
  } catch (err) {
    // Releasing a lock is best-effort — the TTL will clean it up anyway
    logger.warn({ vaultId, token, err }, '[vault-lock] release failed (TTL will clean up)');
  }
}

export class VaultLockService {
  /**
   * Execute an async function while holding an exclusive lock on a vault.
   *
   * The lock is always released in the finally block, even if the critical
   * section throws. If the lock cannot be acquired within the retry window
   * a VaultLockError is thrown and the critical section is never entered.
   *
   * @param vaultId    The vault to lock
   * @param fn         The critical section to execute under the lock
   * @returns          The return value of fn
   * @throws VaultLockError  When the lock cannot be acquired
   */
  async withLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
    const token = await acquireLock(vaultId);
    if (!token) {
      logger.warn({ vaultId }, '[vault-lock] failed to acquire — vault is contended');
      throw new VaultLockError(vaultId);
    }

    try {
      return await fn();
    } finally {
      await releaseLock(vaultId, token);
    }
  }

  /**
   * Check whether a vault is currently locked (for monitoring / circuit-breaker use).
   * Note: a true result is a snapshot — the lock may release by the time you act on it.
   */
  async isLocked(vaultId: string): Promise<boolean> {
    const val = await (redisClient as any).get(lockKey(vaultId));
    return val !== null;
  }
}

export const vaultLockService = new VaultLockService();
