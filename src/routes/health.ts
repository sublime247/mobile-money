import { Router, Request, Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import logger from "../utils/logger";
import {
  ReplicaPoolStatus,
  getReplicaPoolStatus,
  pool,
} from "../config/database";
import { redisClient } from "../config/redis";
import { getReplicationLagReport } from "../services/databaseHealth";
import { checkMobileMoneyHealth } from "../services/mobilemoney/providers/healthCheck";

const router = Router();

interface ComponentStatus {
  status: "up" | "down";
  latencyMs?: number;
  error?: string;
}

interface DeepHealthResponse {
  status: "healthy" | "unhealthy";
  timestamp: string;
  uptimeSeconds: number;
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
  };
  components: {
    database: ComponentStatus;
    redis: ComponentStatus;
    horizon: ComponentStatus;
    providers: Record<string, ComponentStatus>;
    replicas: ReplicaPoolStatus[];
  };
}

/**
 * Pings PostgreSQL with a lightweight SELECT 1.
 */
async function checkDatabase(): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    return { status: "up", latencyMs: Date.now() - start };
  } catch (error) {
    logger.error("[health/deep] Database check failed:", error);
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

/**
 * Pings Redis with PING. Treated as down when the client isn't open,
 * matching the convention already used by /ready and /health/lb.
 */
async function checkRedis(): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    if (!redisClient?.isOpen) {
      return { status: "down", error: "Redis client not connected" };
    }
    if ((await redisClient.ping()) !== "PONG")
      throw new Error("Unexpected Redis response");
    return { status: "up", latencyMs: Date.now() - start };
  } catch (error) {
    logger.error("[health/deep] Redis check failed:", error);
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

/**
 * Pings the configured Stellar Horizon server's root endpoint.
 */
async function checkHorizon(verifySync = false): Promise<ComponentStatus> {
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
  const start = Date.now();
  try {
    const server = new StellarSdk.Horizon.Server(horizonUrl, {
      allowHttp: horizonUrl.startsWith("http://"),
    });
    const root = await server.root();
    if (
      verifySync &&
      (!Number.isFinite(root.history_latest_ledger) ||
        !Number.isFinite(root.core_latest_ledger) ||
        root.history_latest_ledger < root.core_latest_ledger)
    ) {
      return {
        status: "down",
        latencyMs: Date.now() - start,
        error: "Horizon is out of sync",
      };
    }
    return { status: "up", latencyMs: Date.now() - start };
  } catch (error) {
    logger.error("[health/deep] Horizon check failed:", error);
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

/**
 * Aggregates mobile money provider gateway health via the existing
 * circuit-breaker-backed checker used elsewhere in the service.
 */
async function checkProviders(): Promise<Record<string, ComponentStatus>> {
  try {
    const { providers } = await checkMobileMoneyHealth();
    const result: Record<string, ComponentStatus> = {};
    for (const [name, health] of Object.entries(providers)) {
      result[name] = {
        status: health.status,
        ...(health.responseTime !== null
          ? { latencyMs: health.responseTime }
          : {}),
      };
    }
    return result;
  } catch (error) {
    logger.error("[health/deep] Provider health aggregation failed:", error);
    return {};
  }
}

const probeTimeoutMs = 2_000;

async function readinessProbe(
  probe: () => Promise<ComponentStatus>,
): Promise<ComponentStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe(),
      new Promise<ComponentStatus>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "down", error: "Probe timed out" }),
          probeTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

router.get("/health/liveness", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

/**
 * GET /health/database (#2484)
 *
 * Reports replication lag in milliseconds and the last replayed WAL LSN for
 * every configured replica. By default this reads the snapshot cached by the
 * existing lag monitor (no DB round trip); `?fresh=true` triggers an on-demand
 * probe. Returns HTTP 200 always so monitoring can alert on the `alert` flag
 * without this endpoint doubling as a liveness probe.
 */
router.get("/health/database", async (req: Request, res: Response) => {
  const fresh = req.query.fresh === "true";
  const report = await getReplicationLagReport({ fresh });
  res.status(200).json(report);
});

router.get("/health/readiness", async (_req: Request, res: Response) => {
  const [database, redis, horizon] = await Promise.all([
    readinessProbe(checkDatabase),
    readinessProbe(checkRedis),
    readinessProbe(() => checkHorizon(true)),
  ]);
  const ready = database.status === "up" && redis.status === "up";
  // Match deep health's criticality policy and keep accepting queued work
  // during downstream outages.
  const components = Object.fromEntries(
    Object.entries({ database, redis, horizon }).map(([name, component]) => [
      name,
      { status: component.status, latencyMs: component.latencyMs },
    ]),
  );
  res
    .status(ready ? 200 : 503)
    .json({ status: ready ? "ready" : "unready", components });
});

/**
 * GET /health/deep
 *
 * Full dependency health check: PostgreSQL, Redis, Stellar Horizon, and
 * mobile money provider gateways, plus process memory and uptime stats.
 *
 * Returns 200 when database and Redis (the two critical dependencies) are
 * reachable, and 503 otherwise. Horizon and provider gateway outages are
 * reported but do not by themselves flip the top-level status, since the
 * service can still accept and queue transactions while a downstream
 * provider is degraded. Read replicas are likewise informational: reads
 * fall back to the primary when no replica is usable.
 */
router.get("/health/deep", async (_req: Request, res: Response) => {
  const [database, redis, horizon, providers] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkHorizon(),
    checkProviders(),
  ]);

  const criticalHealthy = database.status === "up" && redis.status === "up";
  const memUsage = process.memoryUsage();

  const body: DeepHealthResponse = {
    status: criticalHealthy ? "healthy" : "unhealthy",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      rssMb: Math.round((memUsage.rss / (1024 * 1024)) * 100) / 100,
      heapUsedMb: Math.round((memUsage.heapUsed / (1024 * 1024)) * 100) / 100,
      heapTotalMb: Math.round((memUsage.heapTotal / (1024 * 1024)) * 100) / 100,
    },
    components: {
      database,
      redis,
      horizon,
      providers,
      // Cached by the replica lag monitor, so this adds no extra DB queries.
      replicas: getReplicaPoolStatus(),
    },
  };

  res.status(criticalHealthy ? 200 : 503).json(body);
});

export default router;
export { checkDatabase, checkRedis, checkHorizon, checkProviders };
