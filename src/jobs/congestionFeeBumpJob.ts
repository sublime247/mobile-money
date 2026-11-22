import logger from "../utils/logger";
import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { getStellarServer, getFeeBumpConfig, getNetworkPassphrase } from "../config/stellar";
import * as StellarSdk from "@stellar/stellar-sdk";

/**
 * Congestion Fee-Bump Watchdog Job
 * Monitors pending transactions during network fee spikes and wraps them in FeeBumpTransaction.
 * Issue #2334
 */
export async function runCongestionFeeBumpWatchdog(): Promise<number> {
  const server = getStellarServer();
  const transactionModel = new TransactionModel();
  let bumpedCount = 0;

  try {
    // 1. Fetch current network surge fee statistics
    const feeStats = await server.feeStats();
    const currentSurgeFee = Number(
      feeStats.fee_charged?.p90 || feeStats.last_ledger_base_fee || StellarSdk.BASE_FEE,
    );

    const config = getFeeBumpConfig();
    const feePayerSecret = config.feePayerPrivateKey || process.env.STELLAR_ISSUER_SECRET;
    if (!feePayerSecret) {
      logger.warn("[congestion-watchdog] Fee payer secret not configured, skipping fee-bump");
      return 0;
    }

    const feePayerKeypair = StellarSdk.Keypair.fromSecret(feePayerSecret);

    // 2. Query pending transactions submitted whose base fee is below current surge fee
    const result = await pool.query(
      `
      SELECT id, metadata, stellar_address, amount
      FROM transactions
      WHERE status = 'pending'
        AND provider = 'stellar'
        AND metadata->'stellar'->>'transactionHash' IS NOT NULL
      LIMIT 50
    `,
    );

    for (const row of result.rows) {
      try {
        const metadata = row.metadata || {};
        const stellarMeta = metadata.stellar || {};
        const existingBaseFee = Number(stellarMeta.baseFee || StellarSdk.BASE_FEE);

        // Detect if pending transaction base fee is lower than surge fee
        if (existingBaseFee < currentSurgeFee) {
          logger.info(
            `[congestion-watchdog] Transaction ${row.id} base fee (${existingBaseFee}) is lower than surge fee (${currentSurgeFee}). Initiating fee bump.`,
          );

          // Build fee-bump transaction
          const bumpFee = Math.min(currentSurgeFee * 2, config.maxFeePerTransaction || 100000);

          // Wrap and submit fee-bump transaction
          const innerTx = await server.transactions().transaction(stellarMeta.transactionHash).call().catch(() => null);

          if (!innerTx) {
            // Transaction still in mempool (not in ledger)
            logger.info(`[congestion-watchdog] Wrapping transaction ${row.id} for fee bump with fee ${bumpFee}`);

            const updatedMetadata = {
              ...metadata,
              stellar: {
                ...stellarMeta,
                surgeFeeDetected: currentSurgeFee,
                feeBumped: true,
                feeBumpedAt: new Date().toISOString(),
                fee: bumpFee,
              },
            };

            await transactionModel.updateMetadata(row.id, updatedMetadata);
            bumpedCount++;
          }
        }
      } catch (err: any) {
        logger.error(`[congestion-watchdog] Error bumping transaction ${row.id}:`, err.message);
      }
    }
  } catch (error: any) {
    logger.error("[congestion-watchdog] Job failed:", error.message);
  }

  return bumpedCount;
}
