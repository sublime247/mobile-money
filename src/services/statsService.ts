import logger from "../utils/logger";
import { pool } from "../config/database";
import {
  calculateStellarReserve,
  ReserveInfo,
} from "../utils/stellarReserveCalculator";

export interface GeneralStats {
  totalTransactions: number;
  successRate: number;
  totalVolume: number;
  averageAmount: number;
}

export interface ProviderStats {
  [provider: string]: number;
}

/** Totals plus the distinct-user count, produced by a single scan. */
export interface OverviewStats extends GeneralStats {
  activeUsers: number;
}

export interface TrendPoint {
  period: Date;
  volume: number;
}

/** Provider totals and the volume trend, produced by a single scan. */
export interface VolumeBreakdown {
  byProvider: ProviderStats;
  trends: TrendPoint[];
}

export interface SystemHealthDashboard {
  stellarReserves: ReserveInfo[];
}

export class StatsService {
  /**
   * Totals, success rate and active-user count.
   *
   * All four aggregates share the same filter set (the optional date range),
   * so they are computed in one pass over the range instead of the two
   * sequential table scans this used to take.
   */
  async getOverview(startDate?: Date, endDate?: Date): Promise<OverviewStats> {
    const range = StatsService.dateRange(startDate, endDate);
    const query = `
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as successful,
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) as volume,
        COALESCE(AVG(amount) FILTER (WHERE status = 'completed'), 0) as average,
        COUNT(DISTINCT user_id) as active_users
      FROM transactions
      ${range.conditions ? `WHERE ${range.conditions}` : ""}
    `;

    const { rows } = await pool.query(query, range.params);
    const row = rows[0];

    const total = parseInt(row.total);
    const successful = parseInt(row.successful);

    return {
      totalTransactions: total,
      successRate: total > 0 ? (successful / total) * 100 : 0,
      totalVolume: parseFloat(row.volume),
      averageAmount: parseFloat(row.average),
      activeUsers: parseInt(row.active_users),
    };
  }

  /**
   * Completed volume grouped by provider and by period.
   *
   * The provider totals and the trend are two views of the same rows, so a
   * single GROUP BY (provider, period) scan serves both; the per-provider
   * totals are just the rows folded together in the application.
   */
  async getVolumeBreakdown(
    period: "day" | "week" | "month",
    startDate?: Date,
    endDate?: Date,
  ): Promise<VolumeBreakdown> {
    const interval =
      period === "day" ? "day" : period === "week" ? "week" : "month";
    const params: (string | Date)[] = [interval];
    const range = StatsService.dateRange(startDate, endDate, params);

    const query = `
      SELECT provider, DATE_TRUNC($1, created_at) as period, SUM(amount) as volume
      FROM transactions
      WHERE status = 'completed'
      ${range.conditions ? `AND ${range.conditions}` : ""}
      GROUP BY provider, period
      ORDER BY period ASC
    `;

    const { rows } = await pool.query(query, params);

    const byProvider: ProviderStats = {};
    const trends: TrendPoint[] = [];
    const trendIndex = new Map<string, number>();

    rows.forEach((row) => {
      const volume = parseFloat(row.volume);
      byProvider[row.provider] = (byProvider[row.provider] || 0) + volume;

      const key =
        row.period instanceof Date
          ? row.period.toISOString()
          : String(row.period);
      const index = trendIndex.get(key);
      if (index === undefined) {
        trendIndex.set(key, trends.length);
        trends.push({ period: row.period, volume });
      } else {
        trends[index].volume += volume;
      }
    });

    return { byProvider, trends };
  }

  /**
   * Build the optional `created_at` window as bare `a AND b` conditions,
   * appending its placeholders to `params` so callers keep one numbering
   * scheme across the whole query (the caller owns the WHERE clause).
   */
  private static dateRange(
    startDate?: Date,
    endDate?: Date,
    params: (string | Date)[] = [],
  ): { conditions: string; params: (string | Date)[] } {
    const conditions: string[] = [];

    if (startDate) {
      params.push(startDate);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      conditions.push(`created_at <= $${params.length}`);
    }

    return { conditions: conditions.join(" AND "), params };
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
        }),
      ),
    );

    return { stellarReserves };
  }
}
