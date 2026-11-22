/**
 * Session Revocation Service — issue #2464
 *
 * Invalidates all active JWT tokens and Redis session records for an admin
 * user immediately when their password is changed or their admin role / 
 * permissions are modified.
 *
 * Strategy:
 *   1. token_version  — a monotonic integer column on the users table.
 *      Every JWT minted for a user embeds the current token_version at
 *      issuance time.  The JWT middleware rejects tokens whose embedded
 *      version is lower than the current DB value.
 *
 *   2. issued_after   — a Redis key `user:<id>:jwt_invalidated_at` stores
 *      the Unix epoch of the revocation event.  The stateful JWT verifier
 *      (verifyTokenStateful in src/middleware/auth.ts) already reads this
 *      key and rejects tokens issued before or at this timestamp.
 *
 *   3. Session flush  — all express-session keys belonging to the user are
 *      deleted from Redis so any server-side session state is wiped.
 *
 * Both mechanisms are applied together so revocation works whether the
 * application uses stateless JWT validation (token_version check) or the
 * stateful Redis check path.
 */

import logger from "../utils/logger.js";
import { queryWrite } from "../config/database.js";
import { redisClient, flushUserSessions } from "../config/redis.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RevocationResult {
  userId: string;
  newTokenVersion: number;
  redisKeysInvalidated: boolean;
  sessionsCleared: boolean;
  reason: "password_change" | "role_change" | "permission_revocation" | "admin_action";
}

// ---------------------------------------------------------------------------
// Token-version increment (DB)
// ---------------------------------------------------------------------------

/**
 * Atomically increment the token_version for `userId`.
 * Returns the new version number.
 *
 * Uses a Postgres CTE so the increment and select are one round-trip.
 */
async function incrementTokenVersion(userId: string): Promise<number> {
  const { rows } = await queryWrite<{ token_version: number }>(
    `UPDATE users
        SET token_version = COALESCE(token_version, 0) + 1,
            updated_at    = NOW()
      WHERE id = $1
  RETURNING token_version`,
    [userId],
  );

  if (rows.length === 0) {
    throw new Error(`sessionRevocation: user ${userId} not found`);
  }

  return rows[0].token_version;
}

// ---------------------------------------------------------------------------
// Redis invalidation
// ---------------------------------------------------------------------------

/**
 * Write the `user:<id>:jwt_invalidated_at` key so the stateful JWT verifier
 * rejects all tokens issued before this moment.
 */
async function setJwtInvalidatedAt(userId: string): Promise<void> {
  if (!redisClient.isOpen) return;
  const now = Math.floor(Date.now() / 1000);
  // TTL matches maximum JWT lifetime (1 h) + 1 day buffer
  await redisClient.set(
    `user:${userId}:jwt_invalidated_at`,
    String(now),
    { EX: 90 * 24 * 60 * 60 }, // 90 days
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Revoke all active sessions for `userId` immediately.
 *
 * Call this inside the same request handler that persists the password /
 * role change — typically in the admin update controller.
 *
 * @param userId   - UUID of the admin user being updated
 * @param reason   - Why the revocation is being triggered (for audit logs)
 */
export async function revokeAllUserSessions(
  userId: string,
  reason: RevocationResult["reason"],
): Promise<RevocationResult> {
  logger.info(
    { userId, reason },
    "[sessionRevocation] Revoking all sessions",
  );

  // 1. Increment token_version in DB (invalidates stateless JWT checks)
  const newTokenVersion = await incrementTokenVersion(userId);

  // 2. Write jwt_invalidated_at timestamp to Redis (invalidates stateful checks)
  let redisKeysInvalidated = false;
  try {
    await setJwtInvalidatedAt(userId);
    redisKeysInvalidated = true;
  } catch (err) {
    logger.error(
      { userId, err },
      "[sessionRevocation] Failed to write jwt_invalidated_at to Redis",
    );
  }

  // 3. Flush all express-session records for the user
  let sessionsCleared = false;
  try {
    await flushUserSessions(userId);
    sessionsCleared = true;
  } catch (err) {
    logger.error(
      { userId, err },
      "[sessionRevocation] Failed to flush Redis sessions",
    );
  }

  logger.info(
    { userId, reason, newTokenVersion, redisKeysInvalidated, sessionsCleared },
    "[sessionRevocation] Revocation complete",
  );

  return {
    userId,
    newTokenVersion,
    redisKeysInvalidated,
    sessionsCleared,
    reason,
  };
}

/**
 * Convenience wrapper — call when an admin's password is reset.
 */
export async function revokeSessionsOnPasswordChange(
  userId: string,
): Promise<RevocationResult> {
  return revokeAllUserSessions(userId, "password_change");
}

/**
 * Convenience wrapper — call when an admin's role or permissions change.
 */
export async function revokeSessionsOnPermissionChange(
  userId: string,
): Promise<RevocationResult> {
  return revokeAllUserSessions(userId, "permission_revocation");
}
