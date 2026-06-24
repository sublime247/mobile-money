import { queryRead } from "../config/database";
import { redisClient } from "../config/redis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PercentileMetrics {
  p95_ms: number;
  p99_ms: number;
  median_ms: number;
  mean_ms: number;
  min_ms: number;
  max_ms: number;
  total_count: number;
  sla_breaches_count: number;
  sla_breach_percentage: number;
  status: "green" | "yellow" | "red";
  breaches_by_day?: Array<{
    date: string;
    breach_count: number;
    total_count: number;
  }>;
}

export interface ResolutionTrendData {
  date: string;
  p95_ms: number;
  p99_ms: number;
  breach_count: number;
  total_count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_SECONDS = 300; // 5 minutes cache for percentile calculations
const SLA_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Redis cache key prefixes
const CACHE_KEYS = {
  TRANSACTION_METRICS: "metrics:transactions:percentiles",
  DISPUTE_METRICS: "metrics:disputes:percentiles",
  TRANSACTION_TREND: "metrics:transactions:trend",
  DISPUTE_TREND: "metrics:disputes:trend",
};

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Determines SLA status based on p99 percentile
 */
function getSLAStatus(p99_ms: number, breachPercentage: number): "green" | "yellow" | "red" {
  if (breachPercentage === 0) return "green";
  if (breachPercentage < 5) return "yellow";
  return "red";
}

/**
 * Calculate resolution time in milliseconds
 */
function calculateResolutionTimeMs(createdAt: Date, resolvedAt: Date): number {
  return Math.round(new Date(resolvedAt).getTime() - new Date(createdAt).getTime());
}

// ---------------------------------------------------------------------------
// Transaction Metrics
// ---------------------------------------------------------------------------

/**
 * Get transaction resolution time percentiles
 * Calculates 95th, 99th percentiles and other metrics for transaction resolution times
 */
export async function getTransactionResolutionPercentiles(
  daysBack: number = 30,
): Promise<PercentileMetrics> {
  // Try to get from cache first
  const cached = await redisClient.get(CACHE_KEYS.TRANSACTION_METRICS);
  if (cached) {
    const cachedStr = typeof cached === 'string' ? cached : cached.toString();
    return JSON.parse(cachedStr);
  }

  const query = `
    SELECT
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY 
        EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS p95_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY 
        EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS p99_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY 
        EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS median_ms,
      AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS mean_ms,
      MIN(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS min_ms,
      MAX(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS max_ms,
      COUNT(*) AS total_count,
      COUNT(CASE WHEN EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000 > $1 THEN 1 END) AS sla_breaches_count
    FROM transactions
    WHERE status = 'completed'
      AND created_at >= NOW() - INTERVAL '${daysBack} days'
  `;

  try {
    const result = await queryRead<{
      p95_ms: number;
      p99_ms: number;
      median_ms: number;
      mean_ms: number;
      min_ms: number;
      max_ms: number;
      total_count: string;
      sla_breaches_count: string;
    }>(query, [SLA_THRESHOLD_MS]);

    if (result.rows.length === 0) {
      return createEmptyMetrics();
    }

    const row = result.rows[0];
    const totalCount = parseInt(row.total_count || "0", 10);
    const breachCount = parseInt(row.sla_breaches_count || "0", 10);
    const breachPercentage = totalCount > 0 ? (breachCount / totalCount) * 100 : 0;

    const metrics: PercentileMetrics = {
      p95_ms: Math.round(row.p95_ms || 0),
      p99_ms: Math.round(row.p99_ms || 0),
      median_ms: Math.round(row.median_ms || 0),
      mean_ms: Math.round(row.mean_ms || 0),
      min_ms: Math.round(row.min_ms || 0),
      max_ms: Math.round(row.max_ms || 0),
      total_count: totalCount,
      sla_breaches_count: breachCount,
      sla_breach_percentage: breachPercentage,
      status: getSLAStatus(row.p99_ms || 0, breachPercentage),
    };

    // Cache the result
    await redisClient.setEx(
      CACHE_KEYS.TRANSACTION_METRICS,
      CACHE_TTL_SECONDS,
      JSON.stringify(metrics),
    );

    return metrics;
  } catch (error) {
    console.error("Error calculating transaction percentiles:", error);
    return createEmptyMetrics();
  }
}

/**
 * Get transaction resolution time trends over time
 */
export async function getTransactionResolutionTrends(
  daysBack: number = 7,
): Promise<ResolutionTrendData[]> {
  const cached = await redisClient.get(CACHE_KEYS.TRANSACTION_TREND);
  if (cached) {
    const cachedStr = typeof cached === 'string' ? cached : cached.toString();
    return JSON.parse(cachedStr);
  }

  const query = `
    SELECT
      DATE(created_at) AS date,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY 
        EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS p95_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY 
        EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS p99_ms,
      COUNT(CASE WHEN EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000 > $1 THEN 1 END) AS breach_count,
      COUNT(*) AS total_count
    FROM transactions
    WHERE status = 'completed'
      AND created_at >= NOW() - INTERVAL '${daysBack} days'
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `;

  try {
    const result = await queryRead<{
      date: string;
      p95_ms: number;
      p99_ms: number;
      breach_count: string;
      total_count: string;
    }>(query, [SLA_THRESHOLD_MS]);

    const trends: ResolutionTrendData[] = result.rows.map((row) => ({
      date: row.date,
      p95_ms: Math.round(row.p95_ms || 0),
      p99_ms: Math.round(row.p99_ms || 0),
      breach_count: parseInt(row.breach_count || "0", 10),
      total_count: parseInt(row.total_count || "0", 10),
    }));

    // Cache the result
    await redisClient.setEx(
      CACHE_KEYS.TRANSACTION_TREND,
      CACHE_TTL_SECONDS,
      JSON.stringify(trends),
    );

    return trends;
  } catch (error) {
    console.error("Error calculating transaction trends:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dispute Metrics
// ---------------------------------------------------------------------------

/**
 * Get dispute resolution time percentiles
 */
export async function getDisputeResolutionPercentiles(
  daysBack: number = 30,
): Promise<PercentileMetrics> {
  const cached = await redisClient.get(CACHE_KEYS.DISPUTE_METRICS);
  if (cached) {
    const cachedStr = typeof cached === 'string' ? cached : cached.toString();
    return JSON.parse(cachedStr);
  }

  const query = `
    SELECT
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY 
        EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS p95_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY 
        EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS p99_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY 
        EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS median_ms,
      AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS mean_ms,
      MIN(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS min_ms,
      MAX(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS max_ms,
      COUNT(*) AS total_count,
      COUNT(CASE WHEN EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000 > $1 THEN 1 END) AS sla_breaches_count
    FROM disputes
    WHERE status IN ('resolved', 'rejected', 'reversed', 'upheld')
      AND created_at >= NOW() - INTERVAL '${daysBack} days'
  `;

  try {
    const result = await queryRead<{
      p95_ms: number;
      p99_ms: number;
      median_ms: number;
      mean_ms: number;
      min_ms: number;
      max_ms: number;
      total_count: string;
      sla_breaches_count: string;
    }>(query, [SLA_THRESHOLD_MS]);

    if (result.rows.length === 0) {
      return createEmptyMetrics();
    }

    const row = result.rows[0];
    const totalCount = parseInt(row.total_count || "0", 10);
    const breachCount = parseInt(row.sla_breaches_count || "0", 10);
    const breachPercentage = totalCount > 0 ? (breachCount / totalCount) * 100 : 0;

    const metrics: PercentileMetrics = {
      p95_ms: Math.round(row.p95_ms || 0),
      p99_ms: Math.round(row.p99_ms || 0),
      median_ms: Math.round(row.median_ms || 0),
      mean_ms: Math.round(row.mean_ms || 0),
      min_ms: Math.round(row.min_ms || 0),
      max_ms: Math.round(row.max_ms || 0),
      total_count: totalCount,
      sla_breaches_count: breachCount,
      sla_breach_percentage: breachPercentage,
      status: getSLAStatus(row.p99_ms || 0, breachPercentage),
    };

    // Cache the result
    await redisClient.setEx(
      CACHE_KEYS.DISPUTE_METRICS,
      CACHE_TTL_SECONDS,
      JSON.stringify(metrics),
    );

    return metrics;
  } catch (error) {
    console.error("Error calculating dispute percentiles:", error);
    return createEmptyMetrics();
  }
}

/**
 * Get dispute resolution time trends over time
 */
export async function getDisputeResolutionTrends(
  daysBack: number = 7,
): Promise<ResolutionTrendData[]> {
  const cached = await redisClient.get(CACHE_KEYS.DISPUTE_TREND);
  if (cached) {
    const cachedStr = typeof cached === 'string' ? cached : cached.toString();
    return JSON.parse(cachedStr);
  }

  const query = `
    SELECT
      DATE(created_at) AS date,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY 
        EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS p95_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY 
        EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS p99_ms,
      COUNT(CASE WHEN EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000 > $1 THEN 1 END) AS breach_count,
      COUNT(*) AS total_count
    FROM disputes
    WHERE status IN ('resolved', 'rejected', 'reversed', 'upheld')
      AND created_at >= NOW() - INTERVAL '${daysBack} days'
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `;

  try {
    const result = await queryRead<{
      date: string;
      p95_ms: number;
      p99_ms: number;
      breach_count: string;
      total_count: string;
    }>(query, [SLA_THRESHOLD_MS]);

    const trends: ResolutionTrendData[] = result.rows.map((row) => ({
      date: row.date,
      p95_ms: Math.round(row.p95_ms || 0),
      p99_ms: Math.round(row.p99_ms || 0),
      breach_count: parseInt(row.breach_count || "0", 10),
      total_count: parseInt(row.total_count || "0", 10),
    }));

    // Cache the result
    await redisClient.setEx(
      CACHE_KEYS.DISPUTE_TREND,
      CACHE_TTL_SECONDS,
      JSON.stringify(trends),
    );

    return trends;
  } catch (error) {
    console.error("Error calculating dispute trends:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Create an empty metrics object (for when no data is available)
 */
function createEmptyMetrics(): PercentileMetrics {
  return {
    p95_ms: 0,
    p99_ms: 0,
    median_ms: 0,
    mean_ms: 0,
    min_ms: 0,
    max_ms: 0,
    total_count: 0,
    sla_breaches_count: 0,
    sla_breach_percentage: 0,
    status: "green",
  };
}

/**
 * Invalidate all metrics caches (call when data changes)
 */
export async function invalidateMetricsCache(): Promise<void> {
  await Promise.all([
    redisClient.del(CACHE_KEYS.TRANSACTION_METRICS),
    redisClient.del(CACHE_KEYS.DISPUTE_METRICS),
    redisClient.del(CACHE_KEYS.TRANSACTION_TREND),
    redisClient.del(CACHE_KEYS.DISPUTE_TREND),
  ]);
}
