import logger from "../utils/logger";
import { runVolatilityIndexing } from "../services/fxVolatilityService";

/**
 * Dynamic FX Spread Job (#2572)
 * Schedule: every 15 minutes by default (DYNAMIC_SPREAD_CRON).
 *
 * Indexes the trailing 24h volatility of each mobile money currency pair
 * (FX_DYNAMIC_SPREAD_PAIRS, default NGN/KES/GHS/XAF/XOF/UGX/TZS against USDC),
 * maps it to a spread tier and atomically publishes the spread table to Redis
 * for SEP-38 quoting. A failure leaves the previous snapshot in place until
 * its TTL expires, after which quotes fall back to static spreads.
 */
export const DYNAMIC_SPREAD_CRON = process.env.DYNAMIC_SPREAD_CRON || "*/15 * * * *";

export async function runDynamicSpreadJob(): Promise<void> {
  const snapshot = await runVolatilityIndexing();
  const summary = Object.values(snapshot.pairs)
    .map((p) => `${p.pair}=${p.spreadBps}bps(${p.tier})`)
    .join(", ");
  logger.info(
    `[dynamic-spread] Published ${Object.keys(snapshot.pairs).length} pair spread(s): ${summary || "none"}`,
  );
}
