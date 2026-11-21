import logger from "../utils/logger";
import { Pool, QueryConfig, QueryResult, QueryResultRow, PoolClient } from "pg";
import { auditService } from "../services/auditlogService";
import { isReadOnlyQuery } from "../utils/readOnlyDetector";
import {
  dbReplicaLagSeconds,
  dbReplicaReadEnabled,
  emitPoolMetrics,
} from "../utils/metrics";
import { startDeadlockDetector } from "./deadlockDetector";
import { IS_SANDBOX, SANDBOX_DATABASE_URL, DATABASE_URL, DR_DATABASE_URL } from "./env";
import { isTransientDatabaseConnectionError } from "./databaseErrors";
import { getDbRoutingContext } from "../middleware/readReplicaRouting";


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
  process.env.DB_MAX_CONNECTIONS || "30",
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
  process.env.DB_STATEMENT_TIMEOUT_MS || "15000",
  10,
);
const POOL_ALLOW_EXIT_ON_IDLE =
  process.env.DB_POOL_ALLOW_EXIT_ON_IDLE === "true";
const POOL_IDLE_TIMEOUT_MS = parseInt(
  process.env.DB_POOL_IDLE_TIMEOUT_MS || "30000",
  10,
);
const POOL_CONNECTION_TIMEOUT_MS = parseInt(
  process.env.DB_POOL_CONNECTION_TIMEOUT_MS || "5000",
  10,
);
// Enables TCP keepalive on pool sockets so broken idle connections (e.g. a
// NAT/firewall or failover silently dropping the TCP session) are detected
// and reset at the OS level, instead of surfacing as a hang the next time a
// worker tries to use that connection (#2377).
const POOL_KEEP_ALIVE =
  process.env.DB_POOL_KEEP_ALIVE !== "false";
const POOL_KEEP_ALIVE_INITIAL_DELAY_MS = parseInt(
  process.env.DB_POOL_KEEP_ALIVE_INITIAL_DELAY_MS || "10000",
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
let isPrimaryPoolReconnecting = false;
let primaryPoolReconnectAttempt = 0;
let primaryPoolReconnectPromise: Promise<void> | null = null;

/**
 * Shared implementation behind `pool.query`: slow-query logging, PII access
 * auditing, transient-error retry on the primary and, when `allowReplica` is
 * set, automatic replica routing for read-only statements issued while
 * handling a GET/HEAD request (#2290).
 */
async function runQuery(args: any[], allowReplica: boolean): Promise<any> {
  const queryConfig = args[0];
  const values = args[1];
  const startTime = process.hrtime.bigint();
  const queryString =
    typeof queryConfig === "string" ? queryConfig : (queryConfig?.text ?? "");
  const queryParams =
    typeof queryConfig === "string" ? values : queryConfig?.values;

  try {
    const replicaResult =
      allowReplica && shouldRouteToReplica(queryString, args)
        ? await queryReplica(args)
        : null;
    const result =
      replicaResult ??
      (await executeWithRetry(() => primaryPoolQuery(...args), "query"));
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
}

function attachPrimaryPoolRecovery(poolInstance: Pool): void {
  const originalQuery = poolInstance.query.bind(poolInstance);
  const originalConnect = poolInstance.connect.bind(poolInstance);

  primaryPoolQuery = originalQuery;

  const wrappedPool = poolInstance as Pool & {
    query: (...args: any[]) => Promise<any>;
  };

  wrappedPool.query = (...args: any[]): Promise<any> => runQuery(args, true);

  // pg-pool's own query implementation checks out clients with a callback.
  // Leave that path to pg so query-level recovery can retry it as a whole.
  wrappedPool.connect = ((callback?: Parameters<Pool["connect"]>[0]) => {
    if (callback) return originalConnect(callback);
    return executeWithRetry(() => originalConnect(), "connect");
  }) as Pool["connect"];
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

/**
 * Error listener for PostgreSQL connection pools.
 * Gracefully handles client disconnects, server restarts (e.g. ECONNRESET, 57P01),
 * drains the dead connection from the pool, and schedules reconnection without
 * crashing the process.
 */
export function handlePoolError(
  err: Error & { code?: string },
  client?: PoolClient,
): void {
  const isTransient = isTransientDatabaseConnectionError(err);
  const errorCode = err.code || "UNKNOWN";

  logger.warn(
    `[Database] Connection pool client error [code=${errorCode}]: ${err.message}`,
    {
      errorCode,
      isTransient,
      errorName: err.name,
      message: err.message,
    },
  );

  emitPoolMetrics(pool, "primary");

  // If a specific client errored, drain it from the pool so pg discards it.
  if (client && typeof client.release === "function") {
    try {
      client.release(err);
    } catch (releaseErr) {
      logger.debug(
        "[Database] Error releasing failed client from pool:",
        releaseErr,
      );
    }
  }

  if (isTransient) {
    schedulePrimaryPoolReconnect(err);
  }
}

const DB_HEALTH_CHECK_TIMEOUT_MS = parseInt(
  process.env.DB_HEALTH_CHECK_TIMEOUT_MS || "2000",
  10,
);
const DB_HEALTH_CHECK_INTERVAL_MS = parseInt(
  process.env.DB_HEALTH_CHECK_INTERVAL_MS || "15000",
  10,
);

let poolHealthCheckTimer: NodeJS.Timeout | null = null;

/**
 * Performs a lightweight health check ping (SELECT 1) against the database pool.
 * Emits active, idle, and waiting connection metrics, and triggers automatic
 * pool recovery if the ping encounters a disconnect or error.
 *
 * @param targetPool - Pool instance to ping (defaults to primary pool)
 * @returns true if the ping succeeded, false if unhealthy/disconnected
 */
export async function pingDatabasePool(
  targetPool: Pool = pool,
): Promise<boolean> {
  if (!targetPool) {
    return false;
  }

  emitPoolMetrics(targetPool, "primary");

  let client: PoolClient | null = null;
  let connectPromise: Promise<PoolClient> | null = null;
  try {
    connectPromise = targetPool.connect();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Database pool ping connection timeout")),
        DB_HEALTH_CHECK_TIMEOUT_MS,
      );
    });

    client = await Promise.race([connectPromise, timeoutPromise]);

    await client.query("SELECT 1");
    emitPoolMetrics(targetPool, "primary");
    return true;
  } catch (error) {
    logger.warn("[Database] Pool health check ping failed:", error);
    if (!client && connectPromise) {
      void connectPromise
        .then((lateClient) => {
          try {
            lateClient.release(error as Error);
          } catch {
            // Ignore late-connect release errors
          }
        })
        .catch(() => {
          // Connection already failed; nothing to drain
        });
    }
    if (isTransientDatabaseConnectionError(error)) {
      schedulePrimaryPoolReconnect(error);
    }
    return false;
  } finally {
    if (client) {
      try {
        client.release();
      } catch {
        // Ignore release errors during ping teardown
      }
    }
    emitPoolMetrics(targetPool, "primary");
  }
}

/**
 * Starts background pool health check ping loop.
 */
export function startPoolHealthCheck(
  intervalMs = DB_HEALTH_CHECK_INTERVAL_MS,
): void {
  if (poolHealthCheckTimer) {
    clearInterval(poolHealthCheckTimer);
  }
  poolHealthCheckTimer = setInterval(() => {
    void pingDatabasePool();
  }, intervalMs);
  if (typeof poolHealthCheckTimer.unref === "function") {
    poolHealthCheckTimer.unref();
  }
}

/**
 * Stops background pool health check ping loop.
 */
export function stopPoolHealthCheck(): void {
  if (poolHealthCheckTimer) {
    clearInterval(poolHealthCheckTimer);
    poolHealthCheckTimer = null;
  }
}

export const DB_POOL_WAIT_ALERT_MS = parseInt(
  process.env.DB_POOL_WAIT_ALERT_MS || "2000",
  10,
);

const poolWaitStartedAt = new WeakMap<object, number>();
const instrumentedPools = new WeakSet<object>();

export const attachPoolSaturationListeners = (
  poolInstance: Pool,
  poolName = "primary",
) => {
  if (instrumentedPools.has(poolInstance as object)) return;
  instrumentedPools.add(poolInstance as object);

  const emit = () => emitPoolMetrics(poolInstance, poolName);
  const pendingStarts: number[] = [];

  const onAcquire = (client: unknown) => {
    if (client && typeof client === "object") {
      const started =
        poolWaitStartedAt.get(client as object) ?? pendingStarts.shift();
      if (started !== undefined) {
        poolWaitStartedAt.delete(client as object);
        const waitMs = Date.now() - started;
        if (waitMs > DB_POOL_WAIT_ALERT_MS) {
          const total = (poolInstance as any).totalCount ?? 0;
          const idle = (poolInstance as any).idleCount ?? 0;
          logger.warn(
            {
              pool: poolName,
              waitMs,
              thresholdMs: DB_POOL_WAIT_ALERT_MS,
              waiting: (poolInstance as any).waitingCount ?? 0,
              active: Math.max(0, total - idle),
            },
            "db_pool_wait_exceeded",
          );
        }
      }
    }
    emit();
  };

  poolInstance.on("acquire", onAcquire);
  poolInstance.on("release", emit);
  poolInstance.on("connect", emit);
  poolInstance.on("remove", emit);
  poolInstance.on("error", emit);

  const originalConnect = poolInstance.connect.bind(poolInstance) as any;
  (poolInstance as any).connect = (...args: any[]) => {
    const start = Date.now();
    pendingStarts.push(start);
    const markClient = (client: any) => {
      if (client && typeof client === "object") poolWaitStartedAt.set(client, start);
      return client;
    };
    if (args.length > 0 && typeof args[0] === "function") {
      const cb = args[0];
      args[0] = (err: unknown, client: any, release: any) => {
        if (err) {
          const idx = pendingStarts.indexOf(start);
          if (idx >= 0) pendingStarts.splice(idx, 1);
        } else {
          markClient(client);
        }
        cb(err, client, release);
      };
      return originalConnect(...args);
    }
    const maybePromise = originalConnect(...args);
    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise.then(
        (client: any) => markClient(client),
        (err: unknown) => {
          const idx = pendingStarts.indexOf(start);
          if (idx >= 0) pendingStarts.splice(idx, 1);
          throw err;
        },
      );
    }
    return maybePromise;
  };
};

async function reconnectPrimaryPool(): Promise<void> {
  try {
    const previousPool = pool;
    const nextPool = new Pool(getPoolOptions());

    nextPool.on("error", (err, client) => {
      handlePoolError(err, client);
    });

    attachPoolSaturationListeners(nextPool, "primary");
    attachPrimaryPoolRecovery(nextPool);
    const isHealthy = await pingDatabasePool(nextPool);
    if (!isHealthy) {
      nextPool.end().catch((drainErr) => {
        logger.debug(
          "[Database] Ignored error while ending failed replacement pool:",
          drainErr,
        );
      });
      throw new Error("New pool instance health check failed during reconnect");
    }

    pool = nextPool;
    primaryPoolReconnectAttempt = 0;
    logger.info("[Database] Primary pool reconnected successfully");

    // Automatically drain dead connections from previous pool
    if (previousPool && typeof previousPool.end === "function") {
      previousPool.end().catch((drainErr) => {
        logger.debug(
          "[Database] Ignored error while draining previous pool:",
          drainErr,
        );
      });
    }
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
  keepAlive: boolean;
  keepAliveInitialDelayMillis: number;
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
    keepAlive: overrides.keepAlive ?? POOL_KEEP_ALIVE,
    keepAliveInitialDelayMillis:
      overrides.keepAliveInitialDelayMillis ??
      POOL_KEEP_ALIVE_INITIAL_DELAY_MS,
  };
}

function startPoolMonitor(monitoredPool?: Pool): void {
  // Pool monitor for dynamic sizing during surges (#1652)
}

function createPrimaryPool(): Pool {
  const newPool = new Pool(getPoolOptions());

  newPool.on("error", (err, client) => {
    handlePoolError(err, client);
  });

  attachPoolSaturationListeners(newPool, "primary");
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
 * primary (e.g. GET /api/v1/reports/* and dashboard analytics, #2378). Falls
 * back to the primary when no replica is configured or reachable.
 *
 * Multiple replica URLs can be provided as a comma-separated list in either
 * DATABASE_READ_URL (preferred name, #2378) or the legacy READ_REPLICA_URL.
 * DATABASE_READ_URL takes precedence when both are set. The pool
 * load-balances across all replicas via round-robin.
 */
const replicaUrls: string[] = (
  process.env.DATABASE_READ_URL || process.env.READ_REPLICA_URL
)
  ? (process.env.DATABASE_READ_URL || process.env.READ_REPLICA_URL || "")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean)
  : [];

const REPLICA_SYNC_LAG_THRESHOLD_SECONDS = (() => {
  const threshold = parseFloat(
    process.env.REPLICA_SYNC_LAG_THRESHOLD_SECONDS || "5",
  );
  return Number.isFinite(threshold) ? threshold : 5;
})();
/**
 * Route read-only `pool.query` calls made while serving GET/HEAD requests to
 * a replica (#2290). Set DB_REPLICA_ROUTE_GET=false to keep them on primary.
 * Has no effect unless READ_REPLICA_URL is configured.
 */
const REPLICA_ROUTE_GET_REQUESTS = process.env.DB_REPLICA_ROUTE_GET !== "false";
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

/** Replica URLs with any password masked, for logs, metrics and APIs. */
function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<unparseable replica url>";
  }
}

const replicaLabels: string[] = replicaUrls.map(redactConnectionString);

const replicaStatuses: ReplicaStatus[] = replicaLabels.map((url) => ({
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

// An idle replica client dying (failover, restart, network blip) emits
// `error` on its pool; without a listener that would crash the process.
replicaPools.forEach((replicaPool, idx) => {
  replicaPool.on("error", (err) => {
    logger.warn(
      `[Database] Replica pool client error (${replicaLabels[idx]}): ${err.message}`,
    );
    markReplicaUnavailable(idx);
  });
});

// Track which replica to use next for round-robin load balancing
let replicaIndex = 0;
let replicaLagMonitorTimer: NodeJS.Timeout | null = null;

function getActiveReplicaIndices(): number[] {
  return replicaStatuses
    .map((status, idx) => ({ status, idx }))
    .filter(({ status }) => status.enabled && status.healthy)
    .map(({ idx }) => idx);
}

/**
 * Return the index of the next healthy replica in round-robin order, or null
 * when none is configured or all are disabled.
 */
function getNextReplicaIndex(): number | null {
  const activeIndices = getActiveReplicaIndices();
  if (activeIndices.length === 0) return null;
  const selectedIndex = activeIndices[replicaIndex % activeIndices.length];
  replicaIndex += 1;
  return selectedIndex;
}

/**
 * Take a replica out of rotation immediately, so later reads don't each pay
 * a connection timeout. The lag monitor re-enables it once it answers again.
 */
function markReplicaUnavailable(idx: number): void {
  const status = replicaStatuses[idx];
  if (!status) return;
  replicaStatuses[idx] = { ...status, healthy: false, enabled: false };
  dbReplicaReadEnabled.labels(status.url).set(0);
}

/**
 * Run a query on the next healthy replica. Resolves null (never rejects) when
 * no replica is usable or the replica fails, so the caller can fall back to
 * the primary. Connection-level failures also evict the replica; statement
 * errors (e.g. a function that writes, rejected by a read-only standby) don't,
 * since the replica itself is fine.
 */
async function queryReplica(args: any[]): Promise<any | null> {
  const idx = getNextReplicaIndex();
  if (idx === null) return null;

  let client: PoolClient | null = null;
  try {
    client = await replicaPools[idx].connect();
    const result = await client.query(...(args as [any, any]));
    client.release();
    return result;
  } catch (err) {
    const connectionLost = isTransientDatabaseConnectionError(err);
    // Destroy a broken client instead of handing it back to the pool.
    client?.release(connectionLost ? (err as Error) : undefined);
    if (connectionLost || !client) markReplicaUnavailable(idx);
    logger.warn(
      `[Database] Replica query failed on ${replicaLabels[idx]}, falling back to primary`,
      err,
    );
    return null;
  }
}

/** Whether a `pool.query` call should be served by a replica. */
function shouldRouteToReplica(queryString: string, args: any[]): boolean {
  if (!REPLICA_ROUTE_GET_REQUESTS || replicaPools.length === 0) return false;
  // Callback-style calls expect the primary pool's callback semantics.
  if (typeof args[args.length - 1] === "function") return false;
  if (!getDbRoutingContext()?.useReplicaPool) return false;
  return isReadOnlyQuery(queryString);
}

async function refreshReplicaStatus(idx: number): Promise<void> {
  const url = replicaLabels[idx];
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
    logger.warn(`[Database] Replica health check failed for ${url}:`, error);
  } finally {
    client?.release(healthy ? undefined : true);
  }

  const enabled =
    healthy &&
    lagSeconds !== null &&
    lagSeconds <= REPLICA_SYNC_LAG_THRESHOLD_SECONDS;
  replicaStatuses[idx] = { url, enabled, healthy, lagSeconds };

  dbReplicaLagSeconds.labels(url).set(lagSeconds ?? 0);
  dbReplicaReadEnabled.labels(url).set(enabled ? 1 : 0);
  emitPoolMetrics(replicaPools[idx], `replica_${idx}`);
}

async function refreshAllReplicaStatuses(): Promise<void> {
  await Promise.all(replicaUrls.map((_, idx) => refreshReplicaStatus(idx)));
}

export function startReplicaLagMonitor(
  intervalMs = REPLICA_LAG_MONITOR_INTERVAL_MS,
): void {
  if (replicaUrls.length === 0) return;
  stopReplicaLagMonitor();
  void refreshAllReplicaStatuses();
  replicaLagMonitorTimer = setInterval(() => {
    void refreshAllReplicaStatuses();
  }, intervalMs);
  replicaLagMonitorTimer.unref?.();
}

export function stopReplicaLagMonitor(): void {
  if (replicaLagMonitorTimer) {
    clearInterval(replicaLagMonitorTimer);
    replicaLagMonitorTimer = null;
  }
}

if (process.env.NODE_ENV !== "test") {
  startReplicaLagMonitor();
  startDeadlockDetector(pool);
  startPoolHealthCheck();
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
  signal?: AbortSignal,
): Promise<import("pg").QueryResult<T>> {
  const query = async (): Promise<import("pg").QueryResult<T>> => {
    const replicaResult = await queryReplica([text, params]);
    if (replicaResult) return replicaResult;

    // Fall back: use primary pool (which goes through PgBouncer)
    return runQuery([text, params], false);
  };

  return signal ? raceWithAbortSignal(query(), signal) : query();
}

/**
 * Races `promise` against `signal` aborting. Does not cancel the underlying
 * work server-side (the `pg` pool has no cheap way to do that mid-flight);
 * this exists so a caller — most importantly `requestTimeout` middleware —
 * stops waiting on the query the instant the request's deadline passes,
 * rather than discovering the abort only after the query eventually
 * resolves on its own.
 */
function raceWithAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("Query aborted before it started"));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Query aborted: request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });

    promise
      .then((result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      })
      .catch((err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      });
  });
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
  signal?: AbortSignal,
): Promise<import("pg").QueryResult<T>> {
  // Explicitly primary: bypasses GET-request replica routing, so callers can
  // use it for reads that must see the latest committed data.
  const query = () => runQuery([text, params], false);
  return signal ? raceWithAbortSignal(query(), signal) : query();
}

export interface ReplicaPoolStatus {
  url: string;
  healthy: boolean;
  enabled: boolean;
  lagSeconds: number | null;
  totalConnections: number;
  idleConnections: number;
  waitingClients: number;
}

/**
 * Snapshot of every replica as last observed by the lag monitor (or by a
 * failed query), plus live pool counters. Cheap: no database round trip.
 */
export function getReplicaPoolStatus(): ReplicaPoolStatus[] {
  return replicaStatuses.map((status, idx) => ({
    ...status,
    totalConnections: replicaPools[idx].totalCount,
    idleConnections: replicaPools[idx].idleCount,
    waitingClients: replicaPools[idx].waitingCount,
  }));
}

/**
 * Health check for all replica pools: probes each replica now, updates the
 * routing state, and returns the result – useful for monitoring endpoints.
 */
export async function checkReplicaHealth(): Promise<ReplicaPoolStatus[]> {
  await refreshAllReplicaStatuses();
  return getReplicaPoolStatus();
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

    // PgBouncer's admin console only understands its own SHOW commands, not
    // arbitrary SQL (there is no queryable `pgbouncer.client_lookup` table —
    // querying it fails with "invalid command ... use SHOW HELP"). SHOW
    // CLIENTS lists every client-facing connection (state: active/idle);
    // SHOW SERVERS lists every connection PgBouncer holds to the real
    // Postgres server on the other side of the pool.
    const [clients, servers] = await Promise.all([
      pgbouncerPool.query("SHOW CLIENTS;"),
      pgbouncerPool.query("SHOW SERVERS;"),
    ]);

    await pgbouncerPool.end();

    const clientActive = clients.rows.filter(
      (r: { state?: string }) => r.state === "active",
    ).length;
    const clientIdle = clients.rows.filter(
      (r: { state?: string }) => r.state === "idle",
    ).length;
    const serverActive = servers.rows.filter(
      (r: { state?: string }) => r.state === "active",
    ).length;
    const serverIdle = servers.rows.filter(
      (r: { state?: string }) => r.state === "idle",
    ).length;

    return {
      activeConnections: serverActive,
      idleConnections: serverIdle,
      totalConnections: serverActive + serverIdle,
      clientConnections: clientActive + clientIdle,
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
  const routing = req?.dbRouting;
  if (routing) {
    // GET/HEAD: only read-only statements may go to a replica; anything that
    // writes stays on primary even inside a GET handler. Write requests read
    // from primary too, so they see their own changes.
    return routing.useReplicaPool && isReadOnlyQuery(text)
      ? queryRead<T>(text, params)
      : queryWrite<T>(text, params);
  }

  // No HTTP context: fall back to SQL query-based routing
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
  replicas: ReplicaPoolStatus[];
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
