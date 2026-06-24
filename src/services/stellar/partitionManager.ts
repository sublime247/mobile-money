import { pool } from "../../config/database.js";
import cron from "node-cron";

export class PartitionManager {
  /**
   * Ensures that future partitions are pre-created to avoid insert failures on the 1st of the month.
   * Calls the create_transaction_partitions PL/pgSQL function initialized in migrations.
   * 
   * @param monthsAhead How many months in advance to pre-create partitions
   */
  static async ensurePartitionsExist(monthsAhead: number = 3): Promise<void> {
    try {
      await pool.query(`SELECT create_transaction_partitions($1)`, [monthsAhead]);
      console.log(`[PartitionManager] Successfully ensured transactions partitions exist for next ${monthsAhead} months.`);
    } catch (error) {
      console.error("[PartitionManager] Failed to create future partitions. Ensure the PL/pgSQL function exists.", error);
    }
  }

  /**
   * Starts a cron schedule to check and create partitions on the 1st of every month.
   * Run this on server startup/initialization.
   */
  static startSchedule(): void {
    // Run at 00:00 on the 1st of every month
    cron.schedule("0 0 1 * *", () => {
      this.ensurePartitionsExist();
    });
  }
}