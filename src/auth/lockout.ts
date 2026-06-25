import logger from "../utils/logger";
import { EventEmitter } from "events";
import { redisClient } from "../config/redis";

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS ?? "5", 10);

// Sliding window during which failed attempts are counted (seconds).
const LOCKOUT_WINDOW_SECONDS = parseInt(
  process.env.LOCKOUT_WINDOW_MINUTES ?? "10",
  10,
) * 60;

// How long an account stays locked after crossing the threshold (seconds).
const LOCKOUT_DURATION_SECONDS = parseInt(
  process.env.LOCKOUT_DURATION_MINUTES ?? "30",
  10,
) * 60;

// ─── Redis key helpers ────────────────────────────────────────────────────────

function attemptsKey(identifier: string): string {
  return `lockout:attempts:${identifier}`;
}

function lockedKey(identifier: string): string {
  return `lockout:locked:${identifier}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LockoutRecord {
  attempts: number;
  lockedAt: Date | null;
  lastAttemptAt: Date;
}

export interface LockoutStatus {
  isLocked: boolean;
  attemptsRemaining: number;
  lockedAt: Date | null;
  unlocksAt: Date | null;
  minutesRemaining: number | null;
}

export interface LockoutResult {
  success: boolean;
  message: string;
  lockoutStatus: LockoutStatus;
  justLocked: boolean;
}

// ─── Event Emitter for lockout events ────────────────────────────────────────

export const lockoutEvents = new EventEmitter();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRedisReady(): boolean {
  return redisClient.isOpen;
}

function buildLockedMessage(status: LockoutStatus): string {
  return (
    `Your account has been temporarily locked due to too many failed login attempts. ` +
    `Please try again in ${status.minutesRemaining} minute${status.minutesRemaining === 1 ? "" : "s"}, ` +
    `or contact support to unlock your account immediately.`
  );
}

/**
 * Returns the current lockout status for an identifier.
 * Redis TTL on the lock key drives auto-unlock with no cleanup job needed.
 */
export async function getLockoutStatus(
  identifier: string,
): Promise<LockoutStatus> {
  if (!isRedisReady()) {
    return {
      isLocked: false,
      attemptsRemaining: MAX_LOGIN_ATTEMPTS,
      lockedAt: null,
      unlocksAt: null,
      minutesRemaining: null,
    };
  }

  try {
    const ttl = Number(await redisClient.ttl(lockedKey(identifier)));

    if (ttl > 0) {
      const now = Date.now();
      const unlocksAt = new Date(now + ttl * 1000);
      const minutesRemaining = Math.ceil(ttl / 60);
      const lockedAt = new Date(now - (LOCKOUT_DURATION_SECONDS - ttl) * 1000);

      return {
        isLocked: true,
        attemptsRemaining: 0,
        lockedAt,
        unlocksAt,
        minutesRemaining,
      };
    }

    // Not locked — read current attempt count
    const raw = await redisClient.get(attemptsKey(identifier));
    const attempts = raw ? parseInt(String(raw), 10) : 0;

    return {
      isLocked: false,
      attemptsRemaining: Math.max(0, MAX_LOGIN_ATTEMPTS - attempts),
      lockedAt: null,
      unlocksAt: null,
      minutesRemaining: null,
    };
  } catch (err) {
    logger.error("[Lockout] getLockoutStatus Redis error:", err);
    return {
      isLocked: false,
      attemptsRemaining: MAX_LOGIN_ATTEMPTS,
      lockedAt: null,
      unlocksAt: null,
      minutesRemaining: null,
    };
  }
}

/**
 * Records a failed login attempt in Redis.
 *
 * On the first attempt within the window the counter TTL is set to
 * LOCKOUT_WINDOW_SECONDS so it auto-resets without a cleanup job.
 * When MAX_LOGIN_ATTEMPTS is reached the lock key is written with
 * LOCKOUT_DURATION_SECONDS TTL and the counter is cleared.
 *
 * Returns `justLocked: true` exactly once — when the account transitions
 * from unlocked to locked so the caller can trigger notifications.
 */
export async function recordFailedAttempt(
  identifier: string,
): Promise<LockoutResult> {
  const currentStatus = await getLockoutStatus(identifier);
  if (currentStatus.isLocked) {
    return {
      success: false,
      message: buildLockedMessage(currentStatus),
      lockoutStatus: currentStatus,
      justLocked: false,
    };
  }

  if (!isRedisReady()) {
    const fallbackStatus: LockoutStatus = {
      isLocked: false,
      attemptsRemaining: MAX_LOGIN_ATTEMPTS - 1,
      lockedAt: null,
      unlocksAt: null,
      minutesRemaining: null,
    };
    return {
      success: false,
      message: `Invalid credentials. ${fallbackStatus.attemptsRemaining} attempts remaining before lockout.`,
      lockoutStatus: fallbackStatus,
      justLocked: false,
    };
  }

  try {
    const key = attemptsKey(identifier);

    // Atomically increment the counter.
    const attempts = Number(await redisClient.incr(key));

    // Set the sliding window TTL on the first increment only.
    if (attempts === 1) {
      await redisClient.expire(key, LOCKOUT_WINDOW_SECONDS);
    }

    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      const now = new Date();
      const unlocksAt = new Date(
        now.getTime() + LOCKOUT_DURATION_SECONDS * 1000,
      );

      // Write the lock key. NX prevents overwriting an existing lock.
      await redisClient.set(lockedKey(identifier), "1", {
        EX: LOCKOUT_DURATION_SECONDS,
        NX: true,
      });

      // Clear the attempt counter — the lock key is now authoritative.
      await redisClient.del(key);

      const lockoutStatus: LockoutStatus = {
        isLocked: true,
        attemptsRemaining: 0,
        lockedAt: now,
        unlocksAt,
        minutesRemaining: Math.ceil(LOCKOUT_DURATION_SECONDS / 60),
      };

      lockoutEvents.emit("locked", {
        identifier,
        attempts,
        lockedAt: now,
        unlocksAt,
      });

      console.warn(
        `[Lockout] Account locked: ${identifier} | attempts: ${attempts} | unlocks at: ${unlocksAt.toISOString()}`,
      );

      return {
        success: false,
        message: buildLockedMessage(lockoutStatus),
        lockoutStatus,
        justLocked: true,
      };
    }

    const attemptsRemaining = MAX_LOGIN_ATTEMPTS - attempts;
    const lockoutStatus: LockoutStatus = {
      isLocked: false,
      attemptsRemaining,
      lockedAt: null,
      unlocksAt: null,
      minutesRemaining: null,
    };

    lockoutEvents.emit("failedAttempt", {
      identifier,
      attempts,
      attemptsRemaining,
    });

    return {
      success: false,
      message:
        attemptsRemaining === 1
          ? `Invalid credentials. Warning: 1 attempt remaining before your account is locked.`
          : `Invalid credentials. ${attemptsRemaining} attempts remaining before lockout.`,
      lockoutStatus,
      justLocked: false,
    };
  } catch (err) {
    logger.error("[Lockout] recordFailedAttempt Redis error:", err);
    const fallbackStatus: LockoutStatus = {
      isLocked: false,
      attemptsRemaining: MAX_LOGIN_ATTEMPTS - 1,
      lockedAt: null,
      unlocksAt: null,
      minutesRemaining: null,
    };
    return {
      success: false,
      message: "Invalid credentials.",
      lockoutStatus: fallbackStatus,
      justLocked: false,
    };
  }
}

/**
 * Clears all lockout state for an identifier on successful login.
 */
export async function recordSuccessfulLogin(identifier: string): Promise<void> {
  if (!isRedisReady()) return;
  try {
    const deleted = Number(
      await redisClient.del([lockedKey(identifier), attemptsKey(identifier)]),
    );
    if (deleted > 0) {
      lockoutEvents.emit("reset", { identifier, reason: "successful_login" });
    }
  } catch (err) {
    logger.error("[Lockout] recordSuccessfulLogin Redis error:", err);
  }
}

/**
 * Admin: manually unlock an account and clear its attempt counter.
 * Returns true if an active lock was removed.
 */
export async function adminUnlock(
  identifier: string,
  adminId?: string,
): Promise<boolean> {
  if (!isRedisReady()) return false;
  try {
    const deleted = Number(
      await redisClient.del([lockedKey(identifier), attemptsKey(identifier)]),
    );
    const wasLocked = deleted > 0;
    if (wasLocked) {
      lockoutEvents.emit("unlocked", {
        identifier,
        reason: "admin",
        adminId,
      });
      console.info(
        `[Lockout] Account manually unlocked: ${identifier}${adminId ? ` by admin ${adminId}` : ""}`,
      );
    }
    return wasLocked;
  } catch (err) {
    logger.error("[Lockout] adminUnlock Redis error:", err);
    return false;
  }
}

/**
 * Returns whether an account is currently locked. Convenience wrapper.
 */
export async function isAccountLocked(identifier: string): Promise<boolean> {
  const status = await getLockoutStatus(identifier);
  return status.isLocked;
}
