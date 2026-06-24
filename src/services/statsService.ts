import logger from "../utils/logger";
import { pool } from "../config/database";
import { calculateStellarReserve, ReserveInfo } from "../utils/stellarReserveCalculator";

export interface GeneralStats {
  totalTransactions: number;
  successRate: number;
  totalVolume: number;
  averageAmount: number;
}

export interface ProviderStats {
  [provider: string]: number;
}

export interface SystemHealthDashboard {
  stellarReserves: ReserveInfo[];
}

export class StatsService {
  /**
   * Get general transaction statistics
   */
  async getGeneralStats(
    startDate?: Date,
    endDate?: Date,
  ): Promise<GeneralStats> {
    let query = `
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as successful,
        COALESCE(SUM(amount::numeric) FILTER (WHERE status = 'completed'), 0) as volume,
        COALESCE(AVG(amount::numeric) FILTER (WHERE status = 'completed'), 0) as average
      FROM transactions
      WHERE 1=1
    `;
    const params: (Date | string | number)[] = [];

    if (startDate) {
      params.push(startDate);
      query += ` AND created_at >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate);
      query += ` AND created_at <= $${params.length}`;
    }

    const { rows } = await pool.query(query, params);
    const row = rows[0];

    const total = parseInt(row.total);
    const successful = parseInt(row.successful);

    return {
      totalTransactions: total,
      successRate: total > 0 ? (successful / total) * 100 : 0,
      totalVolume: parseFloat(row.volume),
      averageAmount: parseFloat(row.average),
    };
  }

  /**
   * Get transaction volume grouped by provider
   */
  async getVolumeByProvider(
    startDate?: Date,
    endDate?: Date,
  ): Promise<ProviderStats> {
    let query = `
      SELECT provider, COALESCE(SUM(amount::numeric), 0) as volume
      FROM transactions
      WHERE status = 'completed'
    `;
    const params: (Date | string | number)[] = [];

    if (startDate) {
      params.push(startDate);
      query += ` AND created_at >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate);
      query += ` AND created_at <= $${params.length}`;
    }

    query += " GROUP BY provider";

    const { rows } = await pool.query(query, params);
    const stats: ProviderStats = {};
    rows.forEach((row) => {
      stats[row.provider] = parseFloat(row.volume);
    });

    return stats;
  }

  /**
   * Count active users (users with at least one transaction in the given period)
   */
  async getActiveUsersCount(startDate?: Date, endDate?: Date): Promise<number> {
    let query = `SELECT COUNT(DISTINCT user_id) as count FROM transactions WHERE 1=1`;
    const params: (Date | string | number)[] = [];

    if (startDate) {
      params.push(startDate);
      query += ` AND created_at >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate);
      query += ` AND created_at <= $${params.length}`;
    }

    const { rows } = await pool.query(query, params);
    return parseInt(rows[0].count);
  }

  /**
   * Get volume trend by day, week, or month
   */
  async getVolumeByPeriod(
    period: "day" | "week" | "month",
    startDate?: Date,
    endDate?: Date,
  ) {
    const interval =
      period === "day" ? "day" : period === "week" ? "week" : "month";

    let query = `
      SELECT DATE_TRUNC($1, created_at) as period, SUM(amount::numeric) as volume
      FROM transactions
      WHERE status = 'completed'
    `;
    const params: (string | Date)[] = [interval];

    if (startDate) {
      params.push(startDate);
      query += ` AND created_at >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate);
      query += ` AND created_at <= $${params.length}`;
    }

    query += " GROUP BY period ORDER BY period ASC";

    const { rows } = await pool.query(query, params);
    return rows.map((r) => ({
      period: r.period,
      volume: parseFloat(r.volume),
    }));
  }

  /**
   * Get system health dashboard including Stellar reserves
   */
  async getSystemHealthDashboard(): Promise<SystemHealthDashboard> {
    const keys = (process.env.HOT_WALLET_PUBLIC_KEYS || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    const stellarReserves = await Promise.all(
      keys.map((k) =>
        calculateStellarReserve(k).catch((err) => {
          logger.error(`Failed to calculate reserve for ${k}:`, err);
          return {
            publicKey: k,
            baseReserve: 0,
            trustlineReserve: 0,
            totalRequired: 0,
            nativeBalance: 0,
            availableBalance: 0,
            isBelowThreshold: true,
          };
        })
      )
    );

    return { stellarReserves };
  }
}
