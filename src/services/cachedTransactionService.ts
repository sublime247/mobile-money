import { pool } from "../config/database";
import { cachedQueryManager, CacheTags, QUERY_TTL_POLICIES } from "./cachedQueryManager";
import { TransactionCacheInvalidation, CacheKeyGenerators } from "./cacheAside";

/**
 * Cached Transaction Service
 * Wraps transaction queries with automatic caching and invalidation
 * Implements cache-aside pattern for expensive database queries
 */

export interface TransactionQueryParams {
  userId?: string;
  offset?: number;
  limit?: number;
  startDate?: Date;
  endDate?: Date;
  minAmount?: number;
  maxAmount?: number;
  provider?: string;
  status?: string;
  tags?: string[];
}

/**
 * Get user transaction history with caching
 */
function generateTransactionCacheKey(
  baseKey: string,
  params: Omit<TransactionQueryParams, "userId"> = {},
): string {
  const paramsKeys = Object.keys(params).sort();
  if (paramsKeys.length === 0) return baseKey;

  const normalizedParams: Record<string, unknown> = {};
  for (const key of paramsKeys) {
    normalizedParams[key] = (params as any)[key];
  }

  const serialized = JSON.stringify(normalizedParams);
  const suffix = Buffer.from(serialized).toString("base64");
  return `${baseKey}:${suffix}`;
}

export async function getCachedUserTransactionHistory(
  userId: string,
  params: Omit<TransactionQueryParams, "userId"> = {},
) {
  const cacheKey = generateTransactionCacheKey(
    CacheKeyGenerators.userTransactionHistory(userId),
    params,
  );
  const tags = [CacheTags.userHistory(userId), CacheTags.userTransaction(userId)];
  
  return cachedQueryManager.getOrFetch(
    cacheKey,
    async () => {
      const client = await pool.connect();
      try {
        const query = buildTransactionQuery({ userId, ...params });
        const result = await client.query(query.text, query.values);
        return {
          transactions: result.rows,
          count: result.rowCount || 0,
          params: params,
        };
      } finally {
        client.release();
      }
    },
    {
      ttlSeconds: QUERY_TTL_POLICIES.TRANSACTION_HISTORY,
      tags,
    },
  );
}

/**
 * Get transaction count with caching
 */
export async function getCachedTransactionCount(
  userId: string,
  params: Omit<TransactionQueryParams, "userId"> = {},
) {
  const cacheKey = `${generateTransactionCacheKey(
    CacheKeyGenerators.userTransactionHistory(userId),
    params,
  )}:count`;
  const tags = [CacheTags.userHistory(userId)];
  
  return cachedQueryManager.getOrFetch(
    cacheKey,
    async () => {
      const client = await pool.connect();
      try {
        const query = buildCountQuery({ userId, ...params });
        const result = await client.query(query.text, query.values);
        return result.rows[0].count;
      } finally {
        client.release();
      }
    },
    {
      ttlSeconds: QUERY_TTL_POLICIES.TRANSACTION_HISTORY,
      tags,
    },
  );
}

/**
 * Get user statistics with caching
 */
export async function getCachedUserStats(userId: string) {
  const cacheKey = CacheKeyGenerators.userTransactionStats(userId);
  const tags = [CacheTags.userStats(userId), CacheTags.userTransaction(userId)];

  return cachedQueryManager.getOrFetch(
    cacheKey,
    async () => {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `
          SELECT
            COUNT(*) as total_transactions,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
            SUM(amount) as total_volume,
            AVG(amount) as avg_amount,
            MIN(created_at) as first_transaction,
            MAX(created_at) as last_transaction
          FROM transactions
          WHERE user_id = $1
          `,
          [userId],
        );
        return result.rows[0];
      } finally {
        client.release();
      }
    },
    {
      ttlSeconds: QUERY_TTL_POLICIES.USER_STATS,
      tags,
    },
  );
}

export interface CachedAmlProfileSnapshot {
  historicalCount: number;
  countLastHour: number;
  countLast24Hours: number;
  countLast7Days: number;
  movingAverageAmount: number;
  lastLocationAt: Date | null;
  lastLocationMetadata: Record<string, unknown> | null;
}

export interface CachedAmlProfileOptions {
  excludeTransactionId?: string;
  movingAverageWindowDays?: number;
}

export async function getCachedAmlProfileSnapshot(
  userId: string,
  asOf: Date,
  options: CachedAmlProfileOptions = {},
): Promise<CachedAmlProfileSnapshot> {
  const hourStart = new Date(asOf.getTime() - 60 * 60 * 1000);
  const dayStart = new Date(asOf.getTime() - 24 * 60 * 60 * 1000);
  const weekStart = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000);
  const movingAverageWindowDays = Math.max(1, options.movingAverageWindowDays ?? 30);
  const movingAverageStart = new Date(
    asOf.getTime() - movingAverageWindowDays * 24 * 60 * 60 * 1000,
  );
  const cacheKey = generateTransactionCacheKey(`aml-profile:${userId}`, {
    asOf: asOf.toISOString(),
    excludeTransactionId: options.excludeTransactionId ?? null,
    movingAverageWindowDays,
  });
  const tags = [CacheTags.userHistory(userId), CacheTags.userTransaction(userId)];

  const result = await cachedQueryManager.getOrFetch(
    cacheKey,
    async () => {
      const client = await pool.connect();
      try {
        const snapshot = await client.query<{
          historicalCount: number;
          countLastHour: number;
          countLast24Hours: number;
          countLast7Days: number;
          movingAverageAmount: number | null;
          lastLocationAt: Date | null;
          lastLocationMetadata: Record<string, unknown> | null;
        }>(
          `
          WITH scoped AS (
            SELECT id, amount, created_at, location_metadata
            FROM transactions
            WHERE user_id = $1
              AND created_at <= $2
              AND ($6::uuid IS NULL OR id <> $6::uuid)
          )
          SELECT
            COALESCE((SELECT COUNT(*)::int FROM scoped), 0) AS "historicalCount",
            COALESCE((SELECT COUNT(*)::int FROM scoped WHERE created_at >= $3), 0) AS "countLastHour",
            COALESCE((SELECT COUNT(*)::int FROM scoped WHERE created_at >= $4), 0) AS "countLast24Hours",
            COALESCE((SELECT COUNT(*)::int FROM scoped WHERE created_at >= $5), 0) AS "countLast7Days",
            COALESCE((SELECT AVG(amount)::float8 FROM scoped WHERE created_at >= $7), 0) AS "movingAverageAmount",
            last_loc.created_at AS "lastLocationAt",
            last_loc.location_metadata AS "lastLocationMetadata"
          FROM (SELECT 1) seed
          LEFT JOIN LATERAL (
            SELECT created_at, location_metadata
            FROM scoped
            WHERE location_metadata IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1
          ) last_loc ON TRUE
          `,
          [
            userId,
            asOf,
            hourStart,
            dayStart,
            weekStart,
            options.excludeTransactionId ?? null,
            movingAverageStart,
          ],
        );

        const row = snapshot.rows[0];
        return {
          historicalCount: Number(row?.historicalCount ?? 0),
          countLastHour: Number(row?.countLastHour ?? 0),
          countLast24Hours: Number(row?.countLast24Hours ?? 0),
          countLast7Days: Number(row?.countLast7Days ?? 0),
          movingAverageAmount: Number(row?.movingAverageAmount ?? 0),
          lastLocationAt: row?.lastLocationAt ? new Date(row.lastLocationAt) : null,
          lastLocationMetadata: row?.lastLocationMetadata ?? null,
        };
      } finally {
        client.release();
      }
    },
    {
      ttlSeconds: QUERY_TTL_POLICIES.TRANSACTION_HISTORY,
      tags,
    },
  );

  return result.data;
}

/**
 * Helper to build transaction query with filters
 */
function buildTransactionQuery(params: TransactionQueryParams) {
  const values: any[] = [];
  const whereClauses: string[] = [];
  let paramIndex = 1;
  
  if (params.userId) {
    whereClauses.push(`user_id = $${paramIndex++}`);
    values.push(params.userId);
  }
  
  if (params.status) {
    whereClauses.push(`status = $${paramIndex++}`);
    values.push(params.status);
  }
  
  if (params.provider) {
    whereClauses.push(`provider = $${paramIndex++}`);
    values.push(params.provider);
  }
  
  if (params.startDate) {
    whereClauses.push(`created_at >= $${paramIndex++}`);
    values.push(params.startDate);
  }
  
  if (params.endDate) {
    whereClauses.push(`created_at <= $${paramIndex++}`);
    values.push(params.endDate);
  }
  
  if (params.minAmount !== undefined) {
    whereClauses.push(`amount >= $${paramIndex++}`);
    values.push(params.minAmount);
  }
  
  if (params.maxAmount !== undefined) {
    whereClauses.push(`amount <= $${paramIndex++}`);
    values.push(params.maxAmount);
  }
  
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  
  const offset = params.offset || 0;
  const limit = params.limit || 50;
  
  const text = `
    SELECT id, reference_number, type, amount, phone_number, provider, status,
           stellar_address, tags, notes, admin_notes, user_id, created_at, updated_at
    FROM transactions
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}
  `;
  
  values.push(limit, offset);
  
  return { text, values };
}

/**
 * Helper to build count query
 */
function buildCountQuery(params: TransactionQueryParams) {
  const values: any[] = [];
  const whereClauses: string[] = [];
  
  if (params.userId) {
    values.push(params.userId);
    whereClauses.push(`user_id = $${values.length}`);
  }
  
  if (params.status) {
    values.push(params.status);
    whereClauses.push(`status = $${values.length}`);
  }
  
  if (params.provider) {
    values.push(params.provider);
    whereClauses.push(`provider = $${values.length}`);
  }
  
  if (params.startDate) {
    values.push(params.startDate);
    whereClauses.push(`created_at >= $${values.length}`);
  }
  
  if (params.endDate) {
    values.push(params.endDate);
    whereClauses.push(`created_at <= $${values.length}`);
  }
  
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  
  const text = `SELECT COUNT(*) as count FROM transactions ${whereClause}`;
  
  return { text, values };
}

/**
 * Export invalidation helper for use in transaction creation/update
 */
export const CachedTransactionInvalidation = TransactionCacheInvalidation;
