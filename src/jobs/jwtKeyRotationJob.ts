import logger from "../utils/logger";
import { runKeyRotation } from "../workers/keyRotation";

/**
 * Scheduler entry point for JWT key rotation (issue #1971).
 * Delegates to the shared rotation routine in `src/workers/keyRotation.ts`.
 */
export async function runJwtKeyRotationJob(): Promise<void> {
  logger.info("[JWT-KeyRotation] Scheduled key rotation starting");

  try {
    const { oldKid, newKid } = await runKeyRotation();

    logger.warn(
      { oldKid, newKid },
      "[JWT-KeyRotation] Signing key rotated — old keys remain valid for the configured grace period",
    );
  } catch (err) {
    logger.error("[JWT-KeyRotation] Key rotation failed:", err);
    throw err;
  }
}
