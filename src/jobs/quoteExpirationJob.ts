import logger from "../utils/logger";
import { expireStaleQuotes } from "../services/sep38/quoteService";

/**
 * SEP-38 Quote Expiration Job
 *
 * Sweeps firm quotes that have passed their `expires_at` timestamp and are
 * still in `active` or `pending_execution` status, transitions them to `expired`,
 * releases any reserved liquidity back to the pool, and evicts them from the cache.
 */
export async function runQuoteExpirationJob(): Promise<void> {
  logger.info("[QuoteExpirationJob] Starting sweep for expired SEP-38 firm quotes");
  try {
    const expiredCount = await expireStaleQuotes();
    if (expiredCount > 0) {
      logger.info(
        { expiredCount },
        "[QuoteExpirationJob] Successfully swept expired SEP-38 quotes",
      );
    } else {
      logger.debug("[QuoteExpirationJob] No expired SEP-38 quotes found");
    }
  } catch (error) {
    logger.error(
      { error },
      "[QuoteExpirationJob] Error occurred while sweeping expired SEP-38 quotes",
    );
  }
}
