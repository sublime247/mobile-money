import logger from "../utils/logger";
import { rebalanceReserves } from "../services/stellar/lpRebalanceService";

/**
 * LP Rebalance Job
 * Schedule: Every 5 minutes (configurable via LP_REBALANCE_CRON)
 * Checks distribution account reserves and executes path payments via
 * Stellar liquidity pools to maintain optimal liquidity levels.
 */
export async function runLpRebalanceJob(): Promise<void> {
  const results = await rebalanceReserves();

  for (const r of results) {
    if (r.skipped) {
      console.log(`[lp-rebalance] ${r.assetCode}: OK (${r.reason})`);
    } else if (r.txHash) {
      console.log(
        `[lp-rebalance] ${r.assetCode}: swapped ${r.amountSwapped} — tx ${r.txHash}`
      );
    } else {
      logger.error(
        `[lp-rebalance] ${r.assetCode}: FAILED — ${r.reason}`
      );
    }
  }
}
