import cron from "node-cron";
import { AccountingService } from "../services/accounting";
import { logger } from "../services/logger";

export class AccountingSyncJob {
  private accountingService: AccountingService;
  private isRunning: boolean = false;

  constructor() {
    this.accountingService = new AccountingService();
  }

  start(): void {
    // Run daily at 2 AM UTC
    cron.schedule("0 2 * * *", async () => {
      if (this.isRunning) {
        logger.warn("Accounting sync job already running, skipping");
        return;
      }

      await this.runDailySync();
    });

    // Also run hourly for fee revenue sync (more frequent for better tracking)
    cron.schedule("0 * * * *", async () => {
      if (this.isRunning) {
        logger.warn("Accounting sync job already running, skipping fee sync");
        return;
      }

      await this.runFeeRevenueSync();
    });

    logger.info("Accounting sync jobs scheduled");
  }

  private async runDailySync(): Promise<void> {
    this.isRunning = true;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    logger.info(`Starting daily accounting sync for ${dateStr}`);

    try {
      // Get all active connections
      const connections = await this.getAllActiveConnections();
      
      for (const connection of connections) {
        try {
          logger.info(`Syncing P&L for connection ${connection.id} (${connection.provider})`);
          
          const syncLog = await this.accountingService.syncDailyPnL(connection.id, dateStr);
          
          if (syncLog.status === "completed") {
            logger.info(`P&L sync completed for connection ${connection.id}`);
          } else {
            logger.error(`P&L sync failed for connection ${connection.id}: ${syncLog.errorMessage}`);
          }
        } catch (error) {
          logger.error(`Error syncing P&L for connection ${connection.id}:`, error);
        }
      }

      logger.info(`Daily accounting sync completed for ${dateStr}`);
    } catch (error) {
      logger.error(`Error in daily accounting sync:`, error);
    } finally {
      this.isRunning = false;
    }
  }

  private async runFeeRevenueSync(): Promise<void> {
    this.isRunning = true;
    const today = new Date().toISOString().split('T')[0];

    logger.info(`Starting fee revenue sync for ${today}`);

    try {
      // Get all active connections
      const connections = await this.getAllActiveConnections();
      
      for (const connection of connections) {
        try {
          logger.info(`Syncing fee revenue for connection ${connection.id} (${connection.provider})`);
          
          const syncLog = await this.accountingService.syncFeeRevenue(connection.id, today);
          
          if (syncLog.status === "completed") {
            logger.info(`Fee revenue sync completed for connection ${connection.id}`);
          } else {
            logger.error(`Fee revenue sync failed for connection ${connection.id}: ${syncLog.errorMessage}`);
          }
        } catch (error) {
          logger.error(`Error syncing fee revenue for connection ${connection.id}:`, error);
        }
      }

      logger.info(`Fee revenue sync completed for ${today}`);
    } catch (error) {
      logger.error(`Error in fee revenue sync:`, error);
    } finally {
      this.isRunning = false;
    }
  }

  private async getAllActiveConnections(): Promise<Array<{ id: string; provider: string }>> {
    const { pool } = await import("../config/database");
    const result = await pool.query(
      "SELECT id, provider FROM accounting_connections WHERE is_active = true"
    );
    return result.rows;
  }

  // Manual trigger methods for testing and admin purposes
  async triggerDailySync(date?: string): Promise<void> {
    if (this.isRunning) {
      throw new Error("Sync job is already running");
    }

    const syncDate = date || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    this.isRunning = true;
    try {
      const connections = await this.getAllActiveConnections();
      
      for (const connection of connections) {
        await this.accountingService.syncDailyPnL(connection.id, syncDate);
      }
    } finally {
      this.isRunning = false;
    }
  }

  async triggerFeeRevenueSync(date?: string): Promise<void> {
    if (this.isRunning) {
      throw new Error("Sync job is already running");
    }

    const syncDate = date || new Date().toISOString().split('T')[0];
    
    this.isRunning = true;
    try {
      const connections = await this.getAllActiveConnections();
      
      for (const connection of connections) {
        await this.accountingService.syncFeeRevenue(connection.id, syncDate);
      }
    } finally {
      this.isRunning = false;
    }
  }
}

export const accountingSyncJob = new AccountingSyncJob();
