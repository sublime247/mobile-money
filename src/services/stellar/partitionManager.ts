import logger from "../../utils/logger";
import { pool } from "../../config/database.js";
import cron from "node-cron";

export interface StellarKeyPartition {
  publicKey: string;
  secretKey: string;
  sequenceNumber: string;
  isLocked: boolean;
  updatedAt: Date;
}

export class PartitionManager {
  /**
   * Ensures that future partitions are pre-created to avoid insert failures on the 1st of the month.
   * Calls the create_transaction_partitions PL/pgSQL function initialized in migrations.
   */
  static async ensurePartitionsExist(monthsAhead: number = 3): Promise<void> {
    try {
      await pool.query(`SELECT create_transaction_partitions($1)`, [
        monthsAhead,
      ]);
      console.log(
        `[PartitionManager] Successfully ensured transactions partitions exist for next ${monthsAhead} months.`,
      );
    } catch (error) {
      logger.error("[PartitionManager] Failed to create future partitions. Ensure the PL/pgSQL function exists.", error);
    }
  }

  /**
   * Starts a cron schedule to check and create partitions on the 1st of every month.
   */
  static startSchedule(): void {
    cron.schedule("0 0 1 * *", () => {
      this.ensurePartitionsExist();
    });
  }

  /**
   * STELLAR HIGH-THROUGHPUT TRANSACTION PARTITION QUEUE LOGIC
   */

  /**
   * Acquires a row-level lock on the least recently used/available Stellar channel account partition.
   * Increments and returns the valid sequence number to use for the transaction.
   * * @returns Object containing the chosen public key, secret key, and the sequence string to use.
   */
  static async acquireKeyLock(): Promise<{
    publicKey: string;
    secretKey: string;
    sequence: string;
  }> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Select the first available stellar partition key using a row-level lock (FOR UPDATE SKIP LOCKED)
      // This allows massive parallel execution without workers stepping on each other.
      const queryText = `
        SELECT public_key, secret_key, sequence_number 
        FROM stellar_key_partitions 
        ORDER BY updated_at ASC 
        LIMIT 1 
        FOR UPDATE SKIP LOCKED
      `;
      const result = await client.query(queryText);

      if (result.rows.length === 0) {
        throw new Error(
          "[PartitionManager] No available Stellar partition keys or all are currently locked under heavy load.",
        );
      }

      const row = result.rows[0];

      // Calculate the next sequence number (Stellar sequences are BigInts)
      const currentSeq = BigInt(row.sequence_number);
      const nextSeq = currentSeq + 1n;

      // Update the sequence number and release the least recently used order timestamp
      await client.query(
        `UPDATE stellar_key_partitions 
         SET sequence_number = $1, updated_at = NOW() 
         WHERE public_key = $2`,
        [nextSeq.toString(), row.public_key],
      );

      await client.query("COMMIT");

      return {
        publicKey: row.public_key,
        secretKey: row.secret_key,
        sequence: nextSeq.toString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(
        "[PartitionManager] Failed to acquire or advance key lock:",
        error,
      );
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Sequence Recovery Logic: Recovers and synchronizes a source key's sequence number
   * in case of a bad sequence failure or out-of-sync Horizon ledger state.
   * * @param publicKey The Stellar public key channel that encountered an error
   * @param onChainSequence The correct sequence string fetched directly from Horizon
   */
  static async recoverSequence(
    publicKey: string,
    onChainSequence: string,
  ): Promise<void> {
    try {
      // Synchronize the internal DB sequence tracking with the reality on-chain
      await pool.query(
        `UPDATE stellar_key_partitions 
         SET sequence_number = $1, updated_at = NOW() 
         WHERE public_key = $2`,
        [onChainSequence, publicKey],
      );
      console.log(
        `[PartitionManager] Rebuilt and recovered sequence for key ${publicKey} to ${onChainSequence}`,
      );
    } catch (error) {
      console.error(
        `[PartitionManager] Failed to recover sequence for key ${publicKey}:`,
        error,
      );
      throw error;
    }
  }
}
