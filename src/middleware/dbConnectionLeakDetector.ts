import { Request, Response, NextFunction } from "express";
import { PoolClient } from "pg";
import logger from "../utils/logger";
import { Counter, Gauge, Histogram } from "prom-client";
import { register } from "../utils/metrics";

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
  options?: LeakDetectorOptions & { endpoint?: string; method?: string; requestId?: string },
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
        message: "Database connection still checked out after request completed",
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
          message: "Database connection leak detected - connection not returned",
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