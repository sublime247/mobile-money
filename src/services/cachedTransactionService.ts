import { pool } from "../config/database";
import {
  cachedQueryManager,
  CacheTags,
  QUERY_TTL_POLICIES,
} from "./cachedQueryManager";
import { TransactionCacheInvalidation, CacheKeyGenerators } from "./cacheAside";
import { logger } from "./logger";

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
export async function getCachedUserTransactionHistory(
  userId: string,
  params: Omit<TransactionQueryParams, "userId"> = {},
) {
  const cacheKey = CacheKeyGenerators.userTransactionHistory(userId);
  const tags = [
    CacheTags.userHistory(userId),
    CacheTags.userTransaction(userId),
  ];

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
  const cacheKey = `${CacheKeyGenerators.userTransactionHistory(userId)}:count`;
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

  const whereClause =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

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

  const whereClause =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const text = `SELECT COUNT(*) as count FROM transactions ${whereClause}`;

  return { text, values };
}

/**
 * Export invalidation helper for use in transaction creation/update
 */
export const CachedTransactionInvalidation = TransactionCacheInvalidation;
