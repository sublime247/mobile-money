import { queryRead } from "../config/database";
import { SnapshotModel, DailySnapshot } from "../models/snapshot";
import { EmailService } from "./email";

export interface GrowthMetrics {
  volumeGrowth: number;
  balanceGrowth: number;
}

export class SnapshotService {
  private snapshotModel: SnapshotModel;
  private emailService: EmailService;

  constructor() {
    this.snapshotModel = new SnapshotModel();
    this.emailService = new EmailService();
  }

  async performDailySnapshot(): Promise<DailySnapshot> {
    const today = new Date().toISOString().split("T")[0];

    // 1. Calculate Total Main Balance
    const mainBalanceResult = await queryRead(`
      SELECT COALESCE(SUM(
        CASE 
          WHEN type = 'deposit' THEN amount::numeric
          WHEN type = 'withdraw' THEN -amount::numeric
          ELSE 0
        END
      ), 0)::text AS balance
      FROM transactions
      WHERE status = 'completed'
        AND vault_id IS NULL
    `);
    const totalMainBalance = mainBalanceResult.rows[0].balance;

    // 2. Calculate Total Vault Balance
    const vaultBalanceResult = await queryRead(`
      SELECT COALESCE(SUM(balance::numeric), 0)::text AS balance
      FROM vaults
      WHERE is_active = true
    `);
    const totalVaultBalance = vaultBalanceResult.rows[0].balance;

    // 3. Calculate Total Balance
    const totalBalance = (
      parseFloat(totalMainBalance) + parseFloat(totalVaultBalance)
    ).toString();

    // 4. Calculate Daily Volume and Transaction Count
    // For the current day (up to now)
    const volumeResult = await queryRead(`
      SELECT 
        COALESCE(SUM(amount::numeric), 0)::text AS volume,
        COUNT(*)::int AS count
      FROM transactions
      WHERE status = 'completed'
        AND created_at >= CURRENT_DATE
        AND created_at < CURRENT_DATE + INTERVAL '1 day'
    `);
    const dailyVolume = volumeResult.rows[0].volume;
    const transactionCount = volumeResult.rows[0].count;

    // 5. Save Snapshot
    const snapshot = await this.snapshotModel.create({
      snapshotDate: today,
      totalMainBalance,
      totalVaultBalance,
      totalBalance,
      dailyVolume,
      transactionCount,
    });

    // 6. Calculate Growth Metrics (compared to yesterday)
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toISOString().split("T")[0];
    const yesterdaySnapshot = await this.snapshotModel.getByDate(yesterdayStr);

    const growth: GrowthMetrics = {
      volumeGrowth: 0,
      balanceGrowth: 0,
    };

    if (yesterdaySnapshot) {
      const prevVolume = parseFloat(yesterdaySnapshot.dailyVolume);
      if (prevVolume > 0) {
        growth.volumeGrowth =
          ((parseFloat(dailyVolume) - prevVolume) / prevVolume) * 100;
      }

      const prevBalance = parseFloat(yesterdaySnapshot.totalBalance);
      if (prevBalance > 0) {
        growth.balanceGrowth =
          ((parseFloat(totalBalance) - prevBalance) / prevBalance) * 100;
      }
    }

    // 7. Send Management Summary Email
    const managementEmail =
      process.env.MANAGEMENT_EMAIL ||
      process.env.ORG_SUPPORT_EMAIL ||
      "support@mobilemoney.com";
    await this.emailService.sendManagementSummary(
      managementEmail,
      snapshot,
      growth,
    );

    return snapshot;
  }
}
