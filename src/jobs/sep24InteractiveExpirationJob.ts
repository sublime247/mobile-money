import logger from "../utils/logger";
import { expireStaleInteractiveSessions } from "../stellar/sep24";

/**
 * SEP-24 Interactive Session Expiration Job (#2264)
 *
 * Sweeps interactive deposit/withdrawal sessions that are still waiting on
 * the user (pending_user_transfer_start) and have been open longer than the
 * configurable sep24.interactiveSessionExpiryMinutes duration, transitioning
 * each to `expired` so polling clients and the interactive page see a
 * correct, terminal status even if no one revisits the URL.
 *
 * Mirrors the sweep pattern used for SEP-38 firm quotes
 * (see jobs/quoteExpirationJob.ts + services/sep38/quoteService.expireStaleQuotes).
 */
export async function runSep24InteractiveExpirationJob(): Promise<void> {
  logger.info(
    "[Sep24InteractiveExpirationJob] Starting sweep for expired SEP-24 interactive sessions",
  );
  try {
    const expiredCount = expireStaleInteractiveSessions();
    if (expiredCount > 0) {
      logger.info(
        { expiredCount },
        "[Sep24InteractiveExpirationJob] Successfully swept expired SEP-24 interactive sessions",
      );
    } else {
      logger.debug(
        "[Sep24InteractiveExpirationJob] No expired SEP-24 interactive sessions found",
      );
    }
  } catch (error) {
    logger.error(
      { error },
      "[Sep24InteractiveExpirationJob] Error occurred while sweeping expired SEP-24 interactive sessions",
    );
  }
}
