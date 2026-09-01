import logger from "../utils/logger";
import { Pool, QueryConfig, QueryResult, QueryResultRow, PoolClient } from "pg";
import { auditService } from "../services/auditlogService";
import { isReadOnlyQuery } from "../utils/readOnlyDetector";
import { dbReplicaLagSeconds, dbReplicaReadEnabled } from "../utils/metrics";
import { startDeadlockDetector } from "./deadlockDetector";
import { IS_SANDBOX, SANDBOX_DATABASE_URL, DATABASE_URL, DR_DATABASE_URL } from "./env";
import { isTransientDatabaseConnectionError } from "./databaseErrors";


const isDRMode = (): boolean => !!DR_DATABASE_URL;

const productionSsl =
  process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === "true" }
    : undefined;

// Configuration for slow query logging
const SLOW_QUERY_THRESHOLD_MS = parseInt(
  process.env.SLOW_QUERY_THRESHOLD_MS || "1000",
);
// Queries exceeding this threshold suggest a missing or unused index and trigger
// a higher-severity warning alongside the standard slow-query log entry.
const SLOW_QUERY_INDEX_ALERT_THRESHOLD_MS = parseInt(
  process.env.SLOW_QUERY_INDEX_ALERT_THRESHOLD_MS || "5000",
);
const ENABLE_SLOW_QUERY_LOGGING =
  process.env.ENABLE_SLOW_QUERY_LOGGING === "true" ||
  (process.env.NODE_ENV === "development" &&
    process.env.ENABLE_SLOW_QUERY_LOGGING !== "false");
const PRIMARY_POOL_RECONNECT_DELAY_MS = parseInt(
  process.env.DB_RECONNECT_DELAY_MS || "1000",
  10,
);
const PRIMARY_POOL_MAX_RETRIES = parseInt(
  process.env.DB_MAX_RETRIES || "3",
  10,
);
const MAX_CONNECTIONS = parseInt(
  process.env.DB_MAX_CONNECTIONS || "50",
  10,
);
const POOL_MAX_USES = parseInt(
  process.env.DB_POOL_MAX_USES || "0",
  10,
);
const QUERY_TIMEOUT_MS = parseInt(
  process.env.DB_QUERY_TIMEOUT_MS || "10000",
  10,
);
const STATEMENT_TIMEOUT_MS = parseInt(
  process.env.DB_STATEMENT_TIMEOUT_MS || "10000",
  10,
);
const POOL_ALLOW_EXIT_ON_IDLE =
  process.env.DB_POOL_ALLOW_EXIT_ON_IDLE === "true";
const POOL_IDLE_TIMEOUT_MS = parseInt(
  process.env.DB_POOL_IDLE_TIMEOUT_MS || "15000",
  10,
);
const POOL_CONNECTION_TIMEOUT_MS = parseInt(
  process.env.DB_POOL_CONNECTION_TIMEOUT_MS || "30000",
  10,
);
const REPLICA_IDLE_TIMEOUT_MS = parseInt(
  process.env.DB_REPLICA_IDLE_TIMEOUT_MS || "30000",
  10,
);
const REPLICA_CONNECTION_TIMEOUT_MS = parseInt(
  process.env.DB_REPLICA_CONNECTION_TIMEOUT_MS || "500",
  10,
);

/* ── Pool sizing configuration (#1652) ───────────────────────────── */

/** Base number of connections in the pool (idle baseline). */
const POOL_MIN = parseInt(process.env.DB_POOL_MIN || "10", 10);

/** Maximum connections the pool can scale up to during surges. */
const POOL_MAX = parseInt(process.env.DB_POOL_MAX || "100", 10);

/** Default for when no dynamic max is set. */
const POOL_DEFAULT_MAX = Math.min(
  parseInt(process.env.DB_POOL_DEFAULT_MAX || "25", 10),
  POOL_MAX,
);

/** Utilization ratio above which the pool grows (0.0–1.0). */
const POOL_SCALE_UP_THRESHOLD = parseFloat(
  process.env.DB_POOL_SCALE_UP_THRESHOLD || "0.7",
);

/** Utilization ratio below which the pool shrinks (0.0–1.0). */
const POOL_SCALE_DOWN_THRESHOLD = parseFloat(
  process.env.DB_POOL_SCALE_DOWN_THRESHOLD || "0.3",
);

/** Cooldown between pool resize operations (ms). */
const POOL_RESIZE_COOLDOWN_MS = parseInt(
  process.env.DB_POOL_RESIZE_COOLDOWN_MS || "30000",
  10,
);

/** Database connection limit (from PostgreSQL config). Used to prevent
 *  the pool from exceeding the database's max_connections. */
const DB_MAX_CONNECTIONS = parseInt(
  process.env.DB_MAX_CONNECTIONS || "200",
  10,
);

/** Monitor interval for checking pool utilization (ms). */
const POOL_MONITOR_INTERVAL_MS = parseInt(
  process.env.DB_POOL_MONITOR_INTERVAL_MS || "15000",
  10,
);

/** Active pool size tracking for dynamic resizing. */
let currentPoolMax = POOL_DEFAULT_MAX;
let lastResizeTime = 0;
let resizeInProgress = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


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
 * Logs slow queries with sanitized information.
 * Queries above SLOW_QUERY_INDEX_ALERT_THRESHOLD_MS also emit a warn-level
 * entry flagging a possible missing index.
 */
function logSlowQuery(query: string, duration: number, params?: any[]): void {
  if (!ENABLE_SLOW_QUERY_LOGGING) return;

  const sanitized = sanitizeQuery(query);
  const sanitizedParams = params ? sanitizeParams(params) : undefined;
  const durationRounded = Math.round(duration);

  const logEntry = {
    type: "slow_query",
    duration: durationRounded,
    threshold: SLOW_QUERY_THRESHOLD_MS,
    query: sanitized,
    params: sanitizedParams,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(logEntry));

  if (duration > SLOW_QUERY_INDEX_ALERT_THRESHOLD_MS) {
    logger.warn("possible_missing_index", {
      type: "possible_missing_index",
      duration: durationRounded,
      index_alert_threshold: SLOW_QUERY_INDEX_ALERT_THRESHOLD_MS,
      hint: "Query exceeded index-alert threshold. Review EXPLAIN ANALYZE output and confirm a matching index exists.",
      query: sanitized,
      params: sanitizedParams,
      timestamp: new Date().toISOString(),
    });
  }
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
 * Primary connection pool – now routes through PgBouncer for transaction-level pooling.
 * It also reconnects gracefully after transient disconnects so request handlers can
 * continue operating once the database becomes available again.
 */
let primaryPoolQuery: (...args: any[]) => Promise<any>;
let primaryPoolConnect: () => Promise<PoolClient>;
let isPrimaryPoolReconnecting = false;
let primaryPoolReconnectAttempt = 0;
let primaryPoolReconnectPromise: Promise<void> | null = null;

function attachPrimaryPoolRecovery(poolInstance: Pool): void {
  const originalQuery = poolInstance.query.bind(poolInstance);
  const originalConnect = poolInstance.connect.bind(poolInstance);

  primaryPoolQuery = originalQuery;
  primaryPoolConnect = originalConnect;

  const wrappedPool = poolInstance as Pool & {
    query: (...args: any[]) => Promise<any>;
    connect: () => Promise<PoolClient>;
  };

  wrappedPool.query = async (...args: any[]): Promise<any> => {
    const queryConfig = args[0];
    const values = args[1];
    const startTime = process.hrtime.bigint();
    const queryString =
      typeof queryConfig === "string" ? queryConfig : (queryConfig?.text ?? "");
    const queryParams =
      typeof queryConfig === "string" ? values : queryConfig?.values;

    try {
      const result = await executeWithRetry(
        () => primaryPoolQuery(...args),
        "query",
      );
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1e6;
      if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
        logSlowQuery(queryString, durationMs, queryParams);
      }

      if (
        queryString.toUpperCase().includes("FROM USERS") ||
        queryString.toUpperCase().includes("UPDATE USERS")
      ) {
        const isSelect = queryString.toUpperCase().startsWith("SELECT");
        const isUpdate = queryString.toUpperCase().startsWith("UPDATE");

        if (isSelect || isUpdate) {
          let targetId = "unknown";
          if (queryParams && queryParams.length > 0) {
            targetId = queryParams[queryParams.length - 1];
          }

          setImmediate(() => {
            auditService
              .logPIIAccess({
                adminId: "system-admin",
                targetId: String(targetId),
                resource: "users",
                metadata: {
                  query: sanitizeQuery(queryString),
                  isUpdate,
                },
              })
              .catch((err) =>
                logger.error("[PII Audit Interceptor] Failed:", err),
              );
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

  wrappedPool.connect = async (): Promise<PoolClient> => {
    return executeWithRetry(() => primaryPoolConnect(), "connect");
  };
}

async function verifyPrimaryPoolHealth(): Promise<void> {
  if (!primaryPoolQuery) return;
  await primaryPoolQuery("SELECT 1");
}

async function ensurePrimaryPoolReady(): Promise<void> {
  if (!primaryPoolReconnectPromise) return;
  await primaryPoolReconnectPromise;
}

async function executeWithRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < PRIMARY_POOL_MAX_RETRIES; attempt += 1) {
    try {
      if (isPrimaryPoolReconnecting) {
        await delay(PRIMARY_POOL_RECONNECT_DELAY_MS);
        await verifyPrimaryPoolHealth();
      }

      return await operation();
    } catch (error) {
      lastError = error;

      if (
        !isTransientDatabaseConnectionError(error) ||
        attempt === PRIMARY_POOL_MAX_RETRIES - 1
      ) {
        throw error;
      }

      logger.warn(
        `[Database] ${operationName} failed, retrying in ${PRIMARY_POOL_RECONNECT_DELAY_MS}ms`,
        error,
      );
      schedulePrimaryPoolReconnect(error);
      await delay(PRIMARY_POOL_RECONNECT_DELAY_MS);
      await ensurePrimaryPoolReady();
      await verifyPrimaryPoolHealth();
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function schedulePrimaryPoolReconnect(error: unknown): void {
  if (primaryPoolReconnectPromise) return;

  isPrimaryPoolReconnecting = true;
  primaryPoolReconnectAttempt += 1;
  const reconnectDelayMs = Math.min(
    5000,
    PRIMARY_POOL_RECONNECT_DELAY_MS * primaryPoolReconnectAttempt,
  );

  logger.warn(
    `[Database] Primary pool disconnected, attempting reconnect in ${reconnectDelayMs}ms`,
    error,
  );

  primaryPoolReconnectPromise = new Promise((resolve) => {
    setTimeout(() => {
      void reconnectPrimaryPool().finally(() => {
        primaryPoolReconnectPromise = null;
        isPrimaryPoolReconnecting = false;
        resolve();
      });
    }, reconnectDelayMs);
  });
}

async function reconnectPrimaryPool(): Promise<void> {
  try {
    const previousPool = pool;
    const nextPool = new Pool(getPoolOptions());

    nextPool.on("error", (err) => {
      logger.error("[Database] Primary pool error", err);
      schedulePrimaryPoolReconnect(err);
    });

    attachPrimaryPoolRecovery(nextPool);
    await verifyPrimaryPoolHealth();

    pool = nextPool;
    await previousPool.end();
    primaryPoolReconnectAttempt = 0;
    logger.info("[Database] Primary pool reconnected successfully");
  } catch (error) {
    logger.error("[Database] Primary pool reconnect failed", error);
    setTimeout(() => {
      void reconnectPrimaryPool();
    }, PRIMARY_POOL_RECONNECT_DELAY_MS * 2);
  } finally {
    isPrimaryPoolReconnecting = false;
  }
}

function getPoolOptions(overrides: Partial<{
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  ssl: boolean | undefined;
  maxUses: number;
  allowExitOnIdle: boolean;
  query_timeout: number;
  statement_timeout: number;
}> = {}): object {
  return {
    connectionString: IS_SANDBOX
      ? SANDBOX_DATABASE_URL || DATABASE_URL
      : DATABASE_URL,
    max: overrides.max ?? MAX_CONNECTIONS,
    idleTimeoutMillis: overrides.idleTimeoutMillis ?? POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis:
      overrides.connectionTimeoutMillis ?? POOL_CONNECTION_TIMEOUT_MS,
    ssl: overrides.ssl ?? productionSsl,
    maxUses: overrides.maxUses ?? POOL_MAX_USES,
    allowExitOnIdle: overrides.allowExitOnIdle ?? POOL_ALLOW_EXIT_ON_IDLE,
    query_timeout: overrides.query_timeout ?? QUERY_TIMEOUT_MS,
    statement_timeout: overrides.statement_timeout ?? STATEMENT_TIMEOUT_MS,
  };
}

function startPoolMonitor(monitoredPool?: Pool): void {
  // Pool monitor for dynamic sizing during surges (#1652)
}

function createPrimaryPool(): Pool {
  const newPool = new Pool(getPoolOptions());

  newPool.on("error", (err) => {
    logger.error("[Database] Primary pool error", err);
    schedulePrimaryPoolReconnect(err);
  });

  currentPoolMax = POOL_DEFAULT_MAX;
  attachPrimaryPoolRecovery(newPool);

  // Start pool monitor for dynamic sizing during surges (#1652)
  if (process.env.NODE_ENV !== "test") {
    startPoolMonitor(newPool);
  }

  return newPool;
}

export let pool: Pool = createPrimaryPool();

export async function getPoolClient() {
  return pool.connect();
}

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
  const threshold = parseFloat(
    process.env.REPLICA_SYNC_LAG_THRESHOLD_SECONDS || "5",
  );
  return Number.isFinite(threshold) ? threshold : 5;
})();
const REPLICA_LAG_MONITOR_INTERVAL_MS = (() => {
  const interval = parseInt(
    process.env.REPLICA_LAG_MONITOR_INTERVAL_MS || "10000",
    10,
  );
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
      max: MAX_CONNECTIONS,
      idleTimeoutMillis: REPLICA_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: REPLICA_CONNECTION_TIMEOUT_MS,
      ssl: productionSsl,
      maxUses: POOL_MAX_USES,
      allowExitOnIdle: POOL_ALLOW_EXIT_ON_IDLE,
      query_timeout: QUERY_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
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

  const enabled =
    healthy &&
    lagSeconds !== null &&
    lagSeconds <= REPLICA_SYNC_LAG_THRESHOLD_SECONDS;
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

if (process.env.NODE_ENV !== "test") {
  startReplicaLagMonitor();
  startDeadlockDetector(pool);
}

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
 * Specifically routes transaction log read queries (SELECT) to read-replica pool.
 * Automatically falls back to primary database pool if replicas are offline or unreachable.
 */
export async function queryTransactionLogRead<T extends import("pg").QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  if (!text.trim().toUpperCase().startsWith("SELECT")) {
    // If not a read-only query, route directly to primary write pool
    return queryWrite<T>(text, params);
  }
  return queryRead<T>(text, params);
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
  {
    url: string;
    healthy: boolean;
    enabled: boolean;
    lagSeconds: number | null;
  }[]
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
        const result = await client.query<{ lag_seconds: number | null }>(
          query,
        );
        lagSeconds = result.rows?.[0]?.lag_seconds ?? null;
        healthy = true;
      } catch {
        healthy = false;
      } finally {
        client?.release();
      }

      const enabled =
        healthy &&
        lagSeconds !== null &&
        lagSeconds <= REPLICA_SYNC_LAG_THRESHOLD_SECONDS;
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
      connectionString:
        process.env.PGBOUNCER_ADMIN_URL ||
        "postgresql://user:password@localhost:6432/pgbouncer",
    });

    const result = await pgbouncerPool.query(
      "SELECT sum(cl_active) as active, sum(cl_idle) as idle, sum(sv_active) as sv_active, sum(sv_idle) as sv_idle FROM pgbouncer.client_lookup;",
    );

    await pgbouncerPool.end();

    const row = result.rows[0] || {};
    return {
      activeConnections: parseInt(row.sv_active || 0),
      idleConnections: parseInt(row.sv_idle || 0),
      totalConnections:
        parseInt(row.sv_active || 0) + parseInt(row.sv_idle || 0),
      clientConnections:
        parseInt(row.cl_active || 0) + parseInt(row.cl_idle || 0),
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

/**
 * Executes an array of queries within a database transaction.
 * Ensures the database connection is cleanly released back to the pool on errors/timeouts.
 * 
 * @param queries - Array of { text, params } query configurations
 */
export async function executeTransaction(
  queries: Array<{ text: string; params?: unknown[] }>
): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    for (const query of queries) {
      await client.query(query.text, query.params);
    }
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    // Crucial: Releases the connection regardless of success or timeout failure
    client.release();
  }
}