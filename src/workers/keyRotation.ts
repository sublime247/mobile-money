import cron from "node-cron";
import logger from "../utils/logger";
import {
  GRACE_PERIOD_MS,
  deprecateExpiredKeys,
  rotateKey,
} from "../auth/jwtKeys";

/**
 * JWT key rotation scheduler (issue #1971).
 *
 * Responsibilities:
 * 1. Rotate the signing secret on a configurable cron schedule
 *    (`JWT_KEY_ROTATION_CRON`, default: 1st of each month at 03:00).
 * 2. Deprecate old (secondary) secrets automatically once the grace
 *    window (`JWT_KEY_GRACE_PERIOD_HOURS`, default 24h) elapses. The
 *    sweeper runs every 15 minutes so deprecation happens independently
 *    of rotation timing, including for manually-triggered rotations.
 *
 * Rotation flow (zero downtime):
 *   t0        : key A is primary; tokens signed with A
 *   rotation  : key A demoted to secondary; key B becomes primary
 *               tokens are signed with B, verified with A or B
 *   t0 + 24h  : A is deprecated and no longer accepted
 */

let task: cron.ScheduledTask | null = null;
let sweeperTask: cron.ScheduledTask | null = null;

export async function runKeyRotation(): Promise<{
  oldKid: string;
  newKid: string;
}> {
  const result = await rotateKey();
  logger.warn(
    { oldKid: result.oldKid, newKid: result.newKid },
    "[JWT-KeyRotation] Scheduled rotation completed",
  );
  return result;
}

export function startKeyRotationWorker(): void {
  if (task) return;

  const schedule =
    process.env.JWT_KEY_ROTATION_CRON || "0 3 1 * *"; // monthly default

  if (cron.validate(schedule)) {
    task = cron.schedule(schedule, () => {
      runKeyRotation().catch((err) => {
        logger.error("[JWT-KeyRotation] Scheduled rotation failed:", err);
      });
    });
    logger.info(
      { schedule },
      "[JWT-KeyRotation] Rotation scheduler started",
    );
  } else {
    logger.error(
      { schedule },
      "[JWT-KeyRotation] Invalid JWT_KEY_ROTATION_CRON — rotation scheduler not started",
    );
  }

  // Grace-window sweeper: deprecates old secrets after the configured
  // transition window so verification stops accepting them.
  sweeperTask = cron.schedule("*/15 * * * *", () => {
    try {
      const removed = deprecateExpiredKeys();
      if (removed.length > 0) {
        logger.info(
          { removed },
          "[JWT-KeyRotation] Grace-period sweeper deprecating keys",
        );
      }
    } catch (err) {
      logger.error("[JWT-KeyRotation] Grace sweeper failed:", err);
    }
  });

  logger.info(
    { gracePeriodMs: GRACE_PERIOD_MS },
    "[JWT-KeyRotation] Grace-period sweeper started (every 15 minutes)",
  );
}

export function stopKeyRotationWorker(): void {
  task?.stop();
  sweeperTask?.stop();
  task = null;
  sweeperTask = null;
}
