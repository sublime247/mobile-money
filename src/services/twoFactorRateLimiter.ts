import { redisClient } from "../config/redis";
import { queryWrite } from "../config/database";
import { emailService } from "./email";
import logger from "../utils/logger";

export const MAX_ATTEMPTS = 5;
// 30 minutes (#2380): 5 failed 2FA attempts within a 15-minute window locks
// the account for 30 minutes. The failure-counting window itself is also
// 15 minutes — see the first-increment TTL below.
export const LOCKOUT_DURATION_SECONDS = 30 * 60;
export const FAILURE_WINDOW_SECONDS = 15 * 60;

export interface TwoFactorRateLimitHeaders {
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfter: number;
}

export class TwoFactorRateLimiter {
  private redisPrefix = "2fa:lockout:";

  private getKey(userId: string): string {
    return `${this.redisPrefix}${userId}`;
  }

  /**
   * Check if a user is currently locked out from 2FA
   */
  async isLocked(userId: string): Promise<boolean> {
    if (!redisClient.isOpen) return false;

    const attempts = await redisClient.get(this.getKey(userId));
    return attempts !== null && parseInt(String(attempts), 10) >= MAX_ATTEMPTS;
  }

  /**
   * Increment the failed attempt counter for a user.
   *
   * On the first miss the counter's TTL is the 15-minute failure window
   * (#2380): attempts older than that no longer count toward a lockout.
   * On the attempt that crosses MAX_ATTEMPTS, the TTL is extended to the
   * full 30-minute lockout duration so the account stays locked for that
   * long regardless of how much of the failure window had elapsed, and the
   * lockout side effects (persisting `account_locked_until`, emailing the
   * user) fire exactly once — on this transition, never on repeated
   * attempts made while already locked.
   *
   * @param userId
   * @param email   User's email, used to send the unlock-instructions
   *                notification exactly when the account becomes locked.
   *                Omit if unavailable — the lockout itself still applies.
   * @returns The new attempt count
   */
  async incrementFailures(userId: string, email?: string): Promise<number> {
    if (!redisClient.isOpen) return 0;

    const key = this.getKey(userId);
    const count = await redisClient.incr(key);

    if (count === 1) {
      await redisClient.expire(key, FAILURE_WINDOW_SECONDS);
    }

    if (count === MAX_ATTEMPTS) {
      await redisClient.expire(key, LOCKOUT_DURATION_SECONDS);

      logger.warn(
        {
          event: "security.2fa.account_lockout",
          severity: "high",
          userId,
          attempts: count,
          lockoutSeconds: LOCKOUT_DURATION_SECONDS,
        },
        `[2FA] SECURITY ALERT: user ${userId} locked out after ${count} failed 2FA attempts`,
      );

      await this.applyLockoutSideEffects(userId, email);
    }

    return Number(count);
  }

  /**
   * Persists the lock on the user row and emails unlock instructions.
   * Called exactly once, when a user's failure count first crosses
   * MAX_ATTEMPTS. Both effects are best-effort: a failure here must not
   * prevent the lockout itself (already enforced via Redis) from taking
   * effect, so errors are logged, not thrown.
   */
  private async applyLockoutSideEffects(
    userId: string,
    email?: string,
  ): Promise<void> {
    const unlocksAt = new Date(Date.now() + LOCKOUT_DURATION_SECONDS * 1000);
    const minutesRemaining = Math.ceil(LOCKOUT_DURATION_SECONDS / 60);

    try {
      await queryWrite(
        "UPDATE users SET account_locked_until = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        [unlocksAt, userId],
      );
    } catch (err) {
      logger.error(
        `[2FA] Failed to persist account_locked_until for user ${userId}:`,
        err,
      );
    }

    if (!email) return;

    try {
      await emailService.sendAccountLockoutNotification(email, {
        minutesRemaining,
        unlocksAt,
      });
    } catch (err) {
      logger.error(
        `[2FA] Failed to send lockout notification email for user ${userId}:`,
        err,
      );
    }
  }

  /**
   * Reset the failed attempt counter for a user (called on success).
   * Also clears any persisted account_locked_until (#2380) — best-effort,
   * since the Redis TTL is what actually governs lockout state and this is
   * only reached after a successful verification, which already implies
   * the account wasn't locked.
   */
  async resetFailures(userId: string): Promise<void> {
    if (!redisClient.isOpen) return;

    await redisClient.del(this.getKey(userId));

    try {
      await queryWrite(
        "UPDATE users SET account_locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND account_locked_until IS NOT NULL",
        [userId],
      );
    } catch (err) {
      logger.error(
        `[2FA] Failed to clear account_locked_until for user ${userId}:`,
        err,
      );
    }
  }

  /**
   * Get the number of remaining attempts before lockout
   */
  async getRemainingTries(userId: string): Promise<number> {
    if (!redisClient.isOpen) return MAX_ATTEMPTS;

    const attemptsRaw = await redisClient.get(this.getKey(userId));
    const attempts = attemptsRaw ? parseInt(String(attemptsRaw), 10) : 0;
    return Math.max(0, MAX_ATTEMPTS - attempts);
  }

  /**
   * Get the seconds remaining until the lockout expires
   */
  async getLockoutTimeRemaining(userId: string): Promise<number> {
    if (!redisClient.isOpen) return 0;

    const ttl = await redisClient.ttl(this.getKey(userId));
    return Math.max(0, Number(ttl));
  }

  /**
   * Build standard rate-limit headers for clients.
   */
  async getRateLimitHeaders(
    userId: string,
  ): Promise<TwoFactorRateLimitHeaders> {
    if (!redisClient.isOpen) {
      return {
        limit: MAX_ATTEMPTS,
        remaining: MAX_ATTEMPTS,
        resetAt: new Date(
          Date.now() + LOCKOUT_DURATION_SECONDS * 1000,
        ).toISOString(),
        retryAfter: LOCKOUT_DURATION_SECONDS,
      };
    }

    const attemptsRaw = await redisClient.get(this.getKey(userId));
    const attempts = attemptsRaw ? parseInt(String(attemptsRaw), 10) : 0;
    const remaining = Math.max(0, MAX_ATTEMPTS - attempts);
    const ttl = await redisClient.ttl(this.getKey(userId));
    const retryAfter = Math.max(0, Number(ttl));
    const resetAt = new Date(Date.now() + retryAfter * 1000).toISOString();

    return {
      limit: MAX_ATTEMPTS,
      remaining,
      resetAt,
      retryAfter,
    };
  }
}

export const twoFactorRateLimiter = new TwoFactorRateLimiter();
