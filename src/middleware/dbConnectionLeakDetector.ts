import { Request, Response, NextFunction } from "express";
import { PoolClient } from "pg";
import logger from "../utils/logger";
import { Counter, Gauge, Histogram } from "prom-client";
import { emitPoolMetrics, register } from "../utils/metrics";

const LEAK_LOG_THRESHOLD_MS = parseInt(
  process.env.DB_LEAK_LOG_THRESHOLD_MS || "5000",
);
const LEAK_ALERT_THRESHOLD_SECONDS = parseInt(
  process.env.DB_LEAK_ALERT_THRESHOLD_SECONDS || "30",
);

export const dbConnectionLeaksTotal = new Counter({
  name: "db_connection_leaks_total",
  help: "Total number of detected database connection leaks",
  labelNames: ["type"],
  registers: [register],
});

export const dbLeakedConnectionsGauge = new Gauge({
  name: "db_leaked_connections",
  help: "Number of currently leaked database connections",
  registers: [register],
});

export const dbConnectionCheckoutDurationSeconds = new Histogram({
  name: "db_connection_checkout_duration_seconds",
  help: "Duration of database connection checkout in seconds",
  labelNames: ["pool"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export interface TrackedConnection {
  client: PoolClient;
  checkedOutAt: number;
  checkoutStack: string;
  endpoint: string;
  method: string;
  requestId?: string;
}

const connectionTrackers = new Map<number, TrackedConnection>();

function extractEndpoint(stack: string): string {
  const match = stack.match(/at\s+.*?\s+\((.+):\d+:\d+\)/);
  if (match) {
    const filePath = match[1];
    const fileName = filePath.split("/").pop() || filePath;
    return fileName;
  }
  return "unknown";
}

function setupClientLeakDetection(
  client: PoolClient,
  trackedConn: TrackedConnection,
): void {
  const originalRelease = client.release.bind(client);
  const connectionId = (client as any).processID;

  (client as any).release = function (): void {
    connectionTrackers.delete(connectionId);

    const heldForMs = Date.now() - trackedConn.checkedOutAt;

    dbConnectionCheckoutDurationSeconds.observe(
      { pool: "primary" },
      heldForMs / 1000,
    );

    if (heldForMs > LEAK_LOG_THRESHOLD_MS) {
      dbConnectionLeaksTotal.inc({ type: "slow_return" });
      logger.warn({
        type: "db_connection_slow_return",
        connectionId,
        durationMs: heldForMs,
        thresholdMs: LEAK_LOG_THRESHOLD_MS,
        endpoint: trackedConn.endpoint,
        method: trackedConn.method,
        checkoutStack: trackedConn.checkoutStack,
        message: "Database connection returned slowly",
      });
    }

    return originalRelease.apply(this, arguments as any);
  };
}

export interface LeakDetectorOptions {
  leakLogThresholdMs?: number;
  leakAlertThresholdSeconds?: number;
}

export function trackConnectionCheckout(
  client: PoolClient,
  options?: LeakDetectorOptions & {
    endpoint?: string;
    method?: string;
    requestId?: string;
  },
): void {
  const error = new Error("Connection checkout tracker");
  const stack =
    error.stack?.split("\n").slice(3).join("\n") || "Stack trace unavailable";

  const trackedConn: TrackedConnection = {
    client,
    checkedOutAt: Date.now(),
    checkoutStack: stack,
    endpoint: options?.endpoint || extractEndpoint(stack),
    method: options?.method || "UNKNOWN",
    requestId: options?.requestId,
  };

  connectionTrackers.set((client as any).processID, trackedConn);
  setupClientLeakDetection(client, trackedConn);
}

function findLeakedConnections(): TrackedConnection[] {
  const leaked: TrackedConnection[] = [];
  const now = Date.now();

  for (const [, conn] of connectionTrackers) {
    const heldForSeconds = (now - conn.checkedOutAt) / 1000;
    if (heldForSeconds > LEAK_ALERT_THRESHOLD_SECONDS) {
      leaked.push(conn);
    }
  }

  return leaked;
}

function getEndpointFromRequest(req: Request): string {
  const route = req.route?.path || req.path;
  return `${req.method} ${route}`;
}

function checkForUnreturnedConnections(endpoint: string, req: Request): void {
  const unreturned: TrackedConnection[] = [];

  for (const [, conn] of connectionTrackers) {
    if (conn.endpoint === endpoint && conn.method === req.method) {
      unreturned.push(conn);
    }
  }

  if (unreturned.length > 0) {
    unreturned.forEach((conn) => {
      dbConnectionLeaksTotal.inc({ type: "unreturned_after_request" });
      logger.error({
        type: "db_connection_unreturned",
        endpoint,
        method: req.method,
        heldForMs: Date.now() - conn.checkedOutAt,
        checkoutStack: conn.checkoutStack,
        requestId: req.headers["x-request-id"] as string | undefined,
        message:
          "Database connection still checked out after request completed",
      });
    });
  }
}

export function dbConnectionLeakDetector(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const endpoint = getEndpointFromRequest(req);

  const checkInterval = setInterval(() => {
    const leaked = findLeakedConnections();
    if (leaked.length > 0) {
      dbLeakedConnectionsGauge.set(leaked.length);
      leaked.forEach((conn) => {
        logger.error({
          type: "db_connection_leak",
          endpoint,
          method: req.method,
          heldForMs: Date.now() - conn.checkedOutAt,
          checkoutStack: conn.checkoutStack,
          requestId: req.headers["x-request-id"] as string | undefined,
          message:
            "Database connection leak detected - connection not returned",
        });
      });
    }
  }, 1000);

  req.on("close", () => {
    clearInterval(checkInterval);
    checkForUnreturnedConnections(endpoint, req);
  });

  res.on("finish", () => {
    clearInterval(checkInterval);
  });

  next();
}

export function startPeriodicLeakCheck(
  intervalMs: number = 60000,
): ReturnType<typeof setInterval> | null {
  if (process.env.NODE_ENV === "test") {
    return null;
  }

  return setInterval(() => {
    const leaked = findLeakedConnections();
    if (leaked.length > 0) {
      dbLeakedConnectionsGauge.set(leaked.length);
      leaked.forEach((conn) => {
        dbConnectionLeaksTotal.inc({ type: "hung_connection" });
        logger.error({
          type: "db_connection_hung",
          heldForMs: Date.now() - conn.checkedOutAt,
          checkoutStack: conn.checkoutStack,
          endpoint: conn.endpoint,
          method: conn.method,
          message: "Hung database connection detected",
        });
      });
    }
  }, intervalMs);
}

export function getLeakedConnections(): TrackedConnection[] {
  return findLeakedConnections();
}

export function forceReleaseAllConnections(): number {
  let released = 0;
  for (const [, conn] of connectionTrackers) {
    try {
      conn.client?.release();
      released++;
    } catch (err) {
      logger.error({
        type: "db_connection_force_release_failed",
        error: String(err),
        message: "Failed to force-release connection during cleanup",
      });
    }
  }
  connectionTrackers.clear();
  return released;
}

export function getConnectionTrackerCount(): number {
  return connectionTrackers.size;
}

export function getTrackedConnections(): Map<number, TrackedConnection> {
  return connectionTrackers;
}

// ---------------------------------------------------------------------------
// Connection pool starvation monitoring (#2293)
// ---------------------------------------------------------------------------

const POOL_STARVATION_WAITING_THRESHOLD = parseInt(
  process.env.DB_POOL_STARVATION_WAITING_THRESHOLD || "5",
);
const POOL_STARVATION_DURATION_MS = parseInt(
  process.env.DB_POOL_STARVATION_DURATION_MS || "30000",
);
const POOL_STARVATION_SAMPLE_INTERVAL_MS = parseInt(
  process.env.DB_POOL_STARVATION_SAMPLE_INTERVAL_MS || "5000",
);

export const dbPoolStarvationAlertsTotal = new Counter({
  name: "db_pool_starvation_alerts_total",
  help: "Total number of connection pool starvation alerts raised",
  labelNames: ["pool"],
  registers: [register],
});

export const dbPoolStarvationActive = new Gauge({
  name: "db_pool_starvation_active",
  help: "1 while the connection pool is starved (waiting clients above threshold for the sustained duration), else 0",
  labelNames: ["pool"],
  registers: [register],
});

/** The subset of pg.Pool the monitor reads. */
export interface PoolCountsSource {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options?: { max?: number };
}

export interface PoolStatistics {
  total: number;
  active: number;
  idle: number;
  waiting: number;
  max: number | null;
}

export interface PoolStarvationState extends PoolStatistics {
  pool: string;
  starving: boolean;
  /** When waiting first exceeded the threshold in the current streak, else null. */
  waitingSince: string | null;
}

export interface PoolStarvationAlert {
  pool: string;
  stats: PoolStatistics;
  waitingThreshold: number;
  waitingForMs: number;
}

export interface PoolStarvationMonitorOptions {
  poolName?: string;
  /** Alert when waiting clients exceed this count (strictly greater than). */
  waitingThreshold?: number;
  /** ...continuously for at least this long. */
  durationMs?: number;
  sampleIntervalMs?: number;
  onAlert?: (alert: PoolStarvationAlert) => void;
  onRecover?: (alert: PoolStarvationAlert) => void;
}

export function getPoolStatistics(source: PoolCountsSource): PoolStatistics {
  const total = source.totalCount ?? 0;
  const idle = source.idleCount ?? 0;
  return {
    total,
    active: Math.max(0, total - idle),
    idle,
    waiting: source.waitingCount ?? 0,
    max: source.options?.max ?? null,
  };
}

/**
 * Samples a pg pool's active/idle/waiting counts, exports them to Prometheus,
 * and raises a single alert when more than `waitingThreshold` clients have been
 * waiting for a connection for at least `durationMs`. The alert clears (and
 * may fire again) once the waiting count drops back to the threshold or below.
 *
 * Takes a getter rather than a Pool because the primary pool is replaced on
 * reconnect (see reconnectPrimaryPool in config/database.ts).
 */
export class PoolStarvationMonitor {
  private readonly poolName: string;
  private readonly waitingThreshold: number;
  private readonly durationMs: number;
  private readonly sampleIntervalMs: number;
  private readonly onAlert?: (alert: PoolStarvationAlert) => void;
  private readonly onRecover?: (alert: PoolStarvationAlert) => void;

  private waitingSince: number | null = null;
  private alerting = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastState: PoolStarvationState | null = null;

  constructor(
    private readonly getPool: () => PoolCountsSource | null | undefined,
    options: PoolStarvationMonitorOptions = {},
  ) {
    this.poolName = options.poolName ?? "primary";
    this.waitingThreshold =
      options.waitingThreshold ?? POOL_STARVATION_WAITING_THRESHOLD;
    this.durationMs = options.durationMs ?? POOL_STARVATION_DURATION_MS;
    this.sampleIntervalMs =
      options.sampleIntervalMs ?? POOL_STARVATION_SAMPLE_INTERVAL_MS;
    this.onAlert = options.onAlert;
    this.onRecover = options.onRecover;
  }

  sample(now: number = Date.now()): PoolStarvationState | null {
    const source = this.getPool();
    if (!source) return null;

    const stats = getPoolStatistics(source);
    emitPoolMetrics(source, this.poolName);

    if (stats.waiting > this.waitingThreshold) {
      this.waitingSince ??= now;
      const waitingForMs = now - this.waitingSince;

      if (!this.alerting && waitingForMs >= this.durationMs) {
        this.alerting = true;
        dbPoolStarvationAlertsTotal.inc({ pool: this.poolName });
        dbPoolStarvationActive.set({ pool: this.poolName }, 1);
        const alert = this.buildAlert(stats, waitingForMs);
        logger.error({
          type: "db_pool_starvation",
          ...alert,
          message:
            "Database connection pool starvation: waiting clients above threshold",
        });
        this.onAlert?.(alert);
      }
    } else {
      if (this.alerting) {
        const alert = this.buildAlert(stats, now - (this.waitingSince ?? now));
        logger.info({
          type: "db_pool_starvation_recovered",
          ...alert,
          message: "Database connection pool starvation recovered",
        });
        this.onRecover?.(alert);
      }
      this.alerting = false;
      this.waitingSince = null;
      dbPoolStarvationActive.set({ pool: this.poolName }, 0);
    }

    this.lastState = {
      pool: this.poolName,
      ...stats,
      starving: this.alerting,
      waitingSince:
        this.waitingSince === null
          ? null
          : new Date(this.waitingSince).toISOString(),
    };
    return this.lastState;
  }

  /** Latest sample, taking a fresh one if none has been taken yet. */
  getState(): PoolStarvationState | null {
    return this.lastState ?? this.sample();
  }

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.sampleIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private buildAlert(
    stats: PoolStatistics,
    waitingForMs: number,
  ): PoolStarvationAlert {
    return {
      pool: this.poolName,
      stats,
      waitingThreshold: this.waitingThreshold,
      waitingForMs,
    };
  }
}
