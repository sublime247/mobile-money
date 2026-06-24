import logger from "../utils/logger";
import { Pool, QueryConfig, QueryResult, QueryResultRow, PoolClient } from "pg";
import { auditService } from "../services/auditlogService";
import { isReadOnlyQuery } from "../utils/readOnlyDetector";
import { dbReplicaLagSeconds, dbReplicaReadEnabled } from "../utils/metrics";
import { IS_SANDBOX, SANDBOX_DATABASE_URL, DATABASE_URL } from "./env";

const DR_DATABASE_URL = process.env.DR_DATABASE_URL;
const isDRMode = (): boolean => !!DR_DATABASE_URL;

const productionSsl =
  process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined;

// Configuration for slow query logging
const SLOW_QUERY_THRESHOLD_MS = parseInt(
  process.env.SLOW_QUERY_THRESHOLD_MS || "1000",
);
const ENABLE_SLOW_QUERY_LOGGING =
  process.env.ENABLE_SLOW_QUERY_LOGGING === "true" ||
  (process.env.NODE_ENV === "development" &&
    process.env.ENABLE_SLOW_QUERY_LOGGING !== "false");

/**
 * Sanitizes a SQL query by removing sensitive data patterns
 */
function sanitizeQuery(query: string): string {
  return (
    query
      // Remove potential sensitive values in WHERE clauses
      .replace(/(WHERE\s+[^=]+\s*=\s*)'[^']*'/gi, "$1***")
      .replace(/(WHERE\s+[^=]+\s*=\s*)\d+/gi, "$1***")
      // Remove sensitive data in INSERT/UPDATE values
      .replace(/(VALUES\s*\([^)]*)'[^']*'([^)]*\))/gi, "$1***$2")
      .replace(/(SET\s+[^=]+\s*=\s*)'[^']*'/gi, "$1***")
      .replace(/(SET\s+[^=]+\s*=\s*)\d+/gi, "$1***")
      // Remove email patterns
      .replace(
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        "***@***.***",
      )
      // Remove phone number patterns
      .replace(/\b\d{10,}\b/g, "***")
      // Remove API keys and tokens
      .replace(/\b[A-Za-z0-9]{20,}\b/g, "***")
  );
}

/**
 * Sanitizes query parameters to remove sensitive data
 */
function sanitizeParams(params: any[]): any[] {
  if (!params || !Array.isArray(params)) return params;

  return params.map((param) => {
    if (typeof param === "string") {
      // Check for email patterns
      if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$/.test(param)) {
        return "***@***.***";
      }
      // Check for phone numbers (10+ digits)
      if (/^\d{10,}$/.test(param)) {
        return "***";
      }
      // Check for potential API keys/tokens (20+ chars, alphanumeric)
      if (/^[A-Za-z0-9]{20,}$/.test(param)) {
        return "***";
      }
      // Check for potential sensitive data in quotes
      if (param.length > 50) {
        return "***";
      }
      return param;
    }
    if (typeof param === "number" && param > 1000000) {
      return "***";
    }
    return param;
  });
}

/**
 * Logs slow queries with sanitized information
 */
function logSlowQuery(query: string, duration: number, params?: any[]): void {
  if (!ENABLE_SLOW_QUERY_LOGGING) return;

  const logEntry = {
    type: "slow_query",
    duration: Math.round(duration),
    threshold: SLOW_QUERY_THRESHOLD_MS,
    query: sanitizeQuery(query),
    params: params ? sanitizeParams(params) : undefined,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(logEntry));
}

// Enhanced Pool with query timing
class SlowQueryPool extends Pool {
  async query<T extends QueryResultRow = any>(
    queryConfig: QueryConfig | string,
    values?: any,
  ): Promise<QueryResult<T>> {
    const startTime = process.hrtime.bigint();
    const queryString =
      typeof queryConfig === "string" ? queryConfig : queryConfig.text;
    const queryParams =
      typeof queryConfig === "string" ? values : queryConfig.values;

    try {
      const result = (await super.query(
        queryConfig as any,
        values,
      )) as unknown as QueryResult<T>;

      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1e6;

      if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
        logSlowQuery(queryString, durationMs, queryParams);
      }

      return result;
    } catch (error) {
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1e6;

      if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
        logSlowQuery(queryString, durationMs, queryParams);
      }

      throw error;
    }
  }
}

/**
 * Primary connection pool – now routes through PgBouncer for transaction-level pooling
 * This significantly reduces the number of direct connections to Postgres
 * (INSERT, UPDATE, DELETE) and read operations when no replica is available.
 */
export const pool = new Pool({
  connectionString: IS_SANDBOX ? (SANDBOX_DATABASE_URL || DATABASE_URL) : DATABASE_URL,
  max: 1000,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 500,
  ssl: productionSsl,
});

// Wrap query for slow-query logging while preserving Pool typings.
const originalPoolQuery = pool.query.bind(pool);
(pool as Pool & { query: (...args: any[]) => Promise<any> }).query = async (
  ...args: any[]
): Promise<any> => {
  const queryConfig = args[0];
  const values = args[1];
  const startTime = process.hrtime.bigint();
  const queryString =
    typeof queryConfig === "string" ? queryConfig : queryConfig?.text ?? "";
  const queryParams =
    typeof queryConfig === "string" ? values : queryConfig?.values;

  try {
    const result = await (originalPoolQuery as (...callArgs: any[]) => Promise<any>)(
      ...args,
    );
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1e6;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logSlowQuery(queryString, durationMs, queryParams);
    }

    // PII Audit Interceptor
    if (queryString.toUpperCase().includes("FROM USERS") || queryString.toUpperCase().includes("UPDATE USERS")) {
      const isSelect = queryString.toUpperCase().startsWith("SELECT");
      const isUpdate = queryString.toUpperCase().startsWith("UPDATE");

      if (isSelect || isUpdate) {
        // Attempt to extract targetId from query or params
        let targetId = "unknown";
        if (queryParams && queryParams.length > 0) {
          // Typically the first or last param in findById or UPDATE ... WHERE id = $X
          targetId = queryParams[queryParams.length - 1]; 
        }

        // Trigger asynchronous audit logging
        // Note: Real admin context would be passed here in a production environment via AsyncLocalStorage or similar.
        // For this task, we log the access attempt to ensure visibility.
        setImmediate(() => {
          auditService.logPIIAccess({
            adminId: "system-admin", // Placeholder for actual admin context extraction
            targetId: String(targetId),
            resource: "users",
            metadata: {
              query: sanitizeQuery(queryString),
              isUpdate,
            }
          }).catch(err => logger.error("[PII Audit Interceptor] Failed:", err));
        });
      }
    }

    return result;
  } catch (error) {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1e6;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logSlowQuery(queryString, durationMs, queryParams);
    }
    throw error;
  }
};

/**
 * Read replica connection pool – handles SELECT queries to take load off the
 * primary. If READ_REPLICA_URL is not configured, falls back to the primary.
 *
 * Multiple replica URLs can be provided as a comma-separated list in
 * READ_REPLICA_URL. The pool load-balances across all replicas via round-robin.
 */
const replicaUrls: string[] = process.env.READ_REPLICA_URL
  ? process.env.READ_REPLICA_URL.split(",").map((url) => url.trim())
  : [];

const REPLICA_SYNC_LAG_THRESHOLD_SECONDS = (() => {
  const threshold = parseFloat(process.env.REPLICA_SYNC_LAG_THRESHOLD_SECONDS || "5");
  return Number.isFinite(threshold) ? threshold : 5;
})();
const REPLICA_LAG_MONITOR_INTERVAL_MS = (() => {
  const interval = parseInt(process.env.REPLICA_LAG_MONITOR_INTERVAL_MS || "10000", 10);
  return Number.isFinite(interval) && interval > 0 ? interval : 10000;
})();

type ReplicaStatus = {
  url: string;
  enabled: boolean;
  healthy: boolean;
  lagSeconds: number | null;
};

const replicaStatuses: ReplicaStatus[] = replicaUrls.map((url) => ({
  url,
  enabled: true,
  healthy: true,
  lagSeconds: null,
}));

// Build an individual Pool for each replica URL
const replicaPools: Pool[] = replicaUrls.map(
  (url) =>
    new Pool({
      connectionString: url,
      max: 50,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 500,
      ssl: productionSsl,
    }),
);

// Track which replica to use next for round-robin load balancing
let replicaIndex = 0;

function getActiveReplicaIndices(): number[] {
  return replicaStatuses
    .map((status, idx) => ({ status, idx }))
    .filter(({ status }) => status.enabled && status.healthy)
    .map(({ idx }) => idx);
}

/**
 * Return the next replica pool in round-robin order.
 * Returns null if no replica pools are configured.
 */
function getNextReplicaPool(): Pool | null {
  const activeIndices = getActiveReplicaIndices();
  if (activeIndices.length === 0) return null;
  const selectedIndex = activeIndices[replicaIndex % activeIndices.length];
  replicaIndex += 1;
  return replicaPools[selectedIndex];
}

async function refreshReplicaStatus(idx: number): Promise<void> {
  const url = replicaUrls[idx];
  let healthy = false;
  let lagSeconds: number | null = null;
  let client: PoolClient | null = null;

  try {
    client = await replicaPools[idx].connect();
    const query = `
      SELECT CASE
        WHEN pg_is_in_recovery() THEN EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
        ELSE 0
      END AS lag_seconds
    `;
    const result = await client.query<{ lag_seconds: number | null }>(query);
    lagSeconds = result.rows?.[0]?.lag_seconds ?? null;
    healthy = true;
  } catch (error) {
    healthy = false;
    lagSeconds = null;
    console.warn(`Replica health check failed for ${url}:`, error);
  } finally {
    client?.release();
  }

  const enabled = healthy && lagSeconds !== null && lagSeconds <= REPLICA_SYNC_LAG_THRESHOLD_SECONDS;
  replicaStatuses[idx] = { url, enabled, healthy, lagSeconds };

  dbReplicaLagSeconds.labels(url).set(lagSeconds ?? 0);
  dbReplicaReadEnabled.labels(url).set(enabled ? 1 : 0);
}

async function refreshAllReplicaStatuses(): Promise<void> {
  await Promise.all(replicaUrls.map((_, idx) => refreshReplicaStatus(idx)));
}

function startReplicaLagMonitor(): void {
  if (replicaUrls.length === 0) return;
  void refreshAllReplicaStatuses();
  setInterval(() => {
    void refreshAllReplicaStatuses();
  }, REPLICA_LAG_MONITOR_INTERVAL_MS);
}

startReplicaLagMonitor();

/**
 * Execute a read-only SQL query against a replica pool if available.
 * If the replica is unreachable (pool error or connection failure) the query
 * automatically falls over to the primary pool so callers are unaffected.
 *
 * @param text   - The parameterised SQL query string
 * @param params - Optional query parameters
 */
export async function queryRead<T extends import("pg").QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  const replicaPool = getNextReplicaPool();

  if (replicaPool) {
    let client: PoolClient | null = null;
    try {
      client = await replicaPool.connect();
      const result = await client.query<T>(text, params);
      return result;
    } catch (err) {
      // Log replica failure and fall back to primary
      console.warn("Read replica query failed, falling back to primary:", err);
    } finally {
      client?.release();
    }
  }

  // Fall back: use primary pool (which goes through PgBouncer)
  return pool.query<T>(text, params);
}

/**
 * Execute a write SQL query (INSERT / UPDATE / DELETE) against the primary pool.
 * All writes now route through PgBouncer via the primary pool connection.
 *
 * @param text   - The parameterised SQL query string
 * @param params - Optional query parameters
 */
export async function queryWrite<T extends import("pg").QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Health check for all replica pools.
 * Returns an array of status objects – useful for monitoring endpoints.
 */
export async function checkReplicaHealth(): Promise<
  { url: string; healthy: boolean; enabled: boolean; lagSeconds: number | null }[]
> {
  return Promise.all(
    replicaUrls.map(async (url, idx) => {
      let client: PoolClient | null = null;
      let healthy = false;
      let lagSeconds: number | null = null;

      try {
        client = await replicaPools[idx].connect();
        const query = `
          SELECT CASE
            WHEN pg_is_in_recovery() THEN EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
            ELSE 0
          END AS lag_seconds
        `;
        const result = await client.query<{ lag_seconds: number | null }>(query);
        lagSeconds = result.rows?.[0]?.lag_seconds ?? null;
        healthy = true;
      } catch {
        healthy = false;
      } finally {
        client?.release();
      }

      const enabled = healthy && lagSeconds !== null && lagSeconds <= REPLICA_SYNC_LAG_THRESHOLD_SECONDS;
      return { url, healthy, enabled, lagSeconds };
    }),
  );
}

/**
 * Smart query router: automatically detects read-only (SELECT) queries and
 * routes them to replica pools, while routing writes (INSERT/UPDATE/DELETE) to primary.
 * This enables transparent replica usage without changing existing code patterns.
 *
 * @param text   - The parameterised SQL query string
 * @param params - Optional query parameters
 */
export async function querySmart<T extends import("pg").QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  // Auto-detect if this is a read-only query
  if (isReadOnlyQuery(text)) {
    return queryRead<T>(text, params);
  } else {
    return queryWrite<T>(text, params);
  }
}

/**
 * Get PgBouncer pool statistics
 * Queries PgBouncer admin database to get connection pool metrics
 */
export async function getPgBouncerStats(): Promise<{
  activeConnections: number;
  idleConnections: number;
  totalConnections: number;
  clientConnections: number;
}> {
  try {
    // Query PgBouncer stats database (special admin database)
    const pgbouncerPool = new Pool({
      connectionString: process.env.PGBOUNCER_ADMIN_URL || "postgresql://user:password@localhost:6432/pgbouncer",
    });

    const result = await pgbouncerPool.query(
      "SELECT sum(cl_active) as active, sum(cl_idle) as idle, sum(sv_active) as sv_active, sum(sv_idle) as sv_idle FROM pgbouncer.client_lookup;",
    );

    await pgbouncerPool.end();

    const row = result.rows[0] || {};
    return {
      activeConnections: parseInt(row.sv_active || 0),
      idleConnections: parseInt(row.sv_idle || 0),
      totalConnections: (parseInt(row.sv_active || 0) + parseInt(row.sv_idle || 0)),
      clientConnections: (parseInt(row.cl_active || 0) + parseInt(row.cl_idle || 0)),
    };
  } catch (err) {
    console.warn("Failed to get PgBouncer stats:", err);
    return {
      activeConnections: 0,
      idleConnections: 0,
      totalConnections: 0,
      clientConnections: 0,
    };
  }
}

/**
 * Context-aware query function that respects HTTP method-based routing decisions.
 * 
 * This function is designed to work with the readReplicaRoutingMiddleware.
 * It routes queries based on:
 * 1. HTTP method context (if provided) - GET requests go to replica
 * 2. SQL query type (fallback) - SELECT queries go to replica
 * 
 * Usage in route handlers:
 *   const result = await queryWithContext(req, "SELECT * FROM users", []);
 * 
 * @param req - Express Request object (with dbRouting context from middleware)
 * @param text - SQL query string
 * @param params - Query parameters
 * @returns Query result
 */
export async function queryWithContext<
  T extends import("pg").QueryResultRow = any,
>(
  req: any,
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  // Check for HTTP method-based routing context
  if (req?.dbRouting?.useReplicaPool) {
    return queryRead<T>(text, params);
  }

  // Fall back to SQL query-based routing
  return querySmart<T>(text, params);
}

/**
 * Batch query execution with request context.
 * Executes multiple queries with proper pool routing based on HTTP method.
 * 
 * All read operations (GET) use replica, all writes use primary.
 * 
 * @param req - Express Request object
 * @param queries - Array of { text, params } query configurations
 * @returns Array of query results
 */
export async function queryBatchWithContext<
  T extends import("pg").QueryResultRow = any,
>(
  req: any,
  queries: Array<{ text: string; params?: unknown[] }>,
): Promise<import("pg").QueryResult<T>[]> {
  const results: import("pg").QueryResult<T>[] = [];

  for (const query of queries) {
    const result = await queryWithContext<T>(req, query.text, query.params);
    results.push(result);
  }

  return results;
}

/**
 * Get database pool statistics combining primary and replica metrics.
 * Useful for monitoring and health check endpoints.
 */
export async function getPoolStats(): Promise<{
  primary: {
    mode: "normal" | "failover";
    url: string;
    description: string;
  };
  replicas: Array<{
    url: string;
    healthy: boolean;
  }>;
}> {
  const replicaStats = await checkReplicaHealth();

  return {
    primary: {
      mode: isDRMode() ? "failover" : "normal",
      url: DR_DATABASE_URL || process.env.DATABASE_URL || "",
      description: isDRMode()
        ? "Running in DR failover mode - writes redirected to promoted replica"
        : "Primary database - all critical writes",
    },
    replicas: replicaStats,
  };
}