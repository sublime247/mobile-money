import { pool } from "../config/database";
import { cachedQueryManager, CacheTags, QUERY_TTL_POLICIES } from "./cachedQueryManager";
import { CacheKeyGenerators } from "./cacheAside";

/**
 * Cached Statistics Service
 * Provides caching layer for expensive statistical queries
 */

/**
 * Get general statistics with caching
 */
export async function getCachedGeneralStats(startDate?: Date, endDate?: Date) {
  const cacheKey = CacheKeyGenerators.generalStats();
  const tags = [CacheTags.generalStats()];
  
  return cachedQueryManager.getOrFetch(
    cacheKey,
    async () => {
      const client = await pool.connect();
      try {
        const whereClause = buildDateWhereClause(startDate, endDate);
        const result = await client.query(
          `
          SELECT 
            COUNT(*) as total_transactions,
            COUNT(DISTINCT user_id) as unique_users,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
            SUM(amount) as total_volume,
            AVG(amount) as avg_amount,
            MAX(amount) as max_amount,
            MIN(amount) as min_amount
          FROM transactions
          ${whereClause}
          `,
          whereClause ? [startDate, endDate] : [],
        );
        return result.rows[0];
      } finally {
        client.release();
      }
    },
    {
      ttlSeconds: QUERY_TTL_POLICIES.GENERAL_STATS,
      tags,
    },
  );
}

/**
 * Get volume by provider with caching
 */
export async function getCachedVolumeByProvider(startDate?: Date, endDate?: Date) {
  const cacheKey = CacheKeyGenerators.volumeByProvider(
    startDate?.toISOString() || "all",
    endDate?.toISOString() || "all",
  );
  const tags = [CacheTags.providerVolumes(), CacheTags.generalStats()];
  
  return cachedQueryManager.getOrFetch(
    cacheKey,
    async () => {
      const client = await pool.connect();
      try {
        const whereClause = buildDateWhereClause(startDate, endDate);
        const result = await client.query(
          `
          SELECT 
            provider,
            COUNT(*) as transaction_count,
            SUM(amount) as total_volume,
            AVG(amount) as avg_amount,
            COUNT(DISTINCT user_id) as unique_users,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failure_count
          FROM transactions
          ${whereClause}
          GROUP BY provider
          ORDER BY total_volume DESC
          `,
          whereClause ? [startDate, endDate] : [],
        );
        return result.rows;
      } finally {
        client.release();
      }
    },
    {
      ttlSeconds: QUERY_TTL_POLICIES.VOLUME_BY_PROVIDER,
      tags,
    },
  );
}

/**
 * Get active users count with caching
 */
export async function getCachedActiveUsersCount(startDate?: Date, endDate?: Date) {
  const cacheKey = CacheKeyGenerators.activeUsersCount(
    startDate?.toISOString() || "all",
    endDate?.toISOString() || "all",
  );
  const tags = [CacheTags.generalStats()];
  
  return cachedQueryManager.getOrFetch(
    cacheKey,
    async () => {
      const client = await pool.connect();
      try {
        const whereClause = buildDateWhereClause(startDate, endDate);
        const result = await client.query(
          `
          SELECT COUNT(DISTINCT user_id) as active_users
          FROM transactions
          ${whereClause}
          `,
          whereClause ? [startDate, endDate] : [],
        );
        return result.rows[0].active_users;
      } finally {
        client.release();
      }
    },
    {
      ttlSeconds: QUERY_TTL_POLICIES.ACTIVE_USERS_COUNT,
      tags,
    },
  );
}

/**
 * Get volume by period with caching (daily, weekly, monthly)
 */
export async function getCachedVolumeByPeriod(
  period: "day" | "week" | "month",
  startDate?: Date,
  endDate?: Date,
) {
  const cacheKey = `volume-by-${period}:${startDate?.toISOString() || "all"}:${endDate?.toISOString() || "all"}`;
  const tags = [CacheTags.generalStats()];
  
  const dateFormat = period === "day"
    ? "YYYY-MM-DD"
    : period === "week"
      ? "IYYY-IW"
      : "YYYY-MM";
  
  return cachedQueryManager.getOrFetch(
    cacheKey,
    async () => {
      const client = await pool.connect();
      try {
        const whereClause = buildDateWhereClause(startDate, endDate);
        const result = await client.query(
          `
          SELECT 
            TO_CHAR(created_at, $1) as period,
            COUNT(*) as transaction_count,
            SUM(amount) as total_volume,
            COUNT(DISTINCT user_id) as unique_users
          FROM transactions
          ${whereClause}
          GROUP BY TO_CHAR(created_at, $1)
          ORDER BY period ASC
          `,
          whereClause ? [dateFormat, startDate, endDate] : [dateFormat],
        );
        return result.rows;
      } finally {
        client.release();
      }
    },
    {
      ttlSeconds: QUERY_TTL_POLICIES.GENERAL_STATS,
      tags,
    },
  );
}

/**
 * Helper to build date WHERE clause
 */
function buildDateWhereClause(startDate?: Date, endDate?: Date): string {
  if (!startDate && !endDate) {
    return "";
  }
  
  const clauses: string[] = [];
  if (startDate) {
    clauses.push("created_at >= $1");
  }
  if (endDate) {
    clauses.push(`created_at <= $${startDate ? 2 : 1}`);
  }
  
  return `WHERE ${clauses.join(" AND ")}`;
}
