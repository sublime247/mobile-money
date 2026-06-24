// Initialize centralized configuration first
import "./config/init";

import "./tracer";
import path from "path";
import express, { NextFunction, Request, Response } from "express";
import { IncomingMessage, Server } from "http";
import compression from "compression";
import dotenv from "dotenv";
import helmet from "helmet";
import * as Sentry from "@sentry/node";
import { register } from "prom-client";
import spdy from "spdy";
import fs from "fs";
import session from "express-session";
import type { SessionOptions } from "express-session";
import {
  apiVersionMiddleware,
  validateVersionMiddleware,
  VersionedRequest,
} from "./middleware/apiVersion";
import {
  bulkRoutesV1,
  disputeRoutesV1,
  statsRoutesV1,
  transactionDisputeRoutesV1,
  transactionRoutesV1,
  vaultRoutesV1,
} from "./routes/v1";
import { transactionRoutes } from "./routes/transactions";
import { authRoutes } from "./routes/auth";
import { bulkRoutes } from "./routes/bulk";
import { transactionDisputeRoutes, disputeRoutes } from "./routes/disputes";
import { statsRoutes } from "./routes/stats";
import { contactsRoutes } from "./routes/contacts";
import { reportsRoutes } from "./routes/reports";
import feesRoutes from "./routes/fees";
import { createKYCRoutes } from "./routes/kycRoutes";
import { adminRoutes } from "./routes/admin";
import kycTierUpgradeRoutes from "./routes/kycTierUpgradeRoutes";
import { userRoutes } from "./routes/users";
import { createError, errorHandler } from "./middleware/errorHandler";
import {
  connectRedis,
  disconnectRedis,
  redisClient,
  createRedisStore,
  SESSION_TTL_SECONDS,
} from "./config/redis";
import { createOAuthRouter } from "./auth/oauth";
import { pool } from "./config/database";
import {
  globalTimeout,
  haltOnTimedout,
  timeoutErrorHandler,
} from "./middleware/timeout";
import { requireAuth } from "./middleware/auth";
import { responseTime } from "./middleware/responseTime";
import { requestId } from "./middleware/requestId";
import { readReplicaRoutingMiddleware } from "./middleware/readReplicaRouting";
import { dbConnectionLeakDetector } from "./middleware/dbConnectionLeakDetector";
import { i18nMiddleware } from "./utils/i18n";
import { metricsMiddleware } from "./middleware/metrics";
import { validateStellarNetwork, logStellarNetwork } from "./config/stellar";
import { sessionAnomalyLogger } from "./services/logger";
import { HealthCheckResponse, ReadinessCheckResponse } from "./types/api";
import { privacyRoutes } from "./routes/privacy";
import { developerDashboardRoutes } from "./routes/developerDashboard";
import { travelRuleRoutes } from "./routes/travelRule";
import mtnCallbacksRouter from "./routes/mtnCallbacks";
import orangeMadagascarCallbacksRouter from "./routes/orangeMadagascarCallbacks";
import sep31Router from "./stellar/sep31";
import sep24Router from "./stellar/sep24";
import sep38Router from "./stellar/sep38";
import { createSep12Router } from "./stellar/sep12";
import { createSep10Router } from "./stellar/sep10";
import { sep30Routes } from "./routes/sep30";
import { createAdminSep10Router } from "./stellar/adminSep10";
import tomlRouter from "./routes/toml";
import feeStrategiesRouter from "./routes/feeStrategies";
import crossChainRouter from "./routes/crossChain";
import stellarRouter from "./routes/stellar";
import reconciliationRoutes from "./routes/reconciliation";
import accountingReconciliationRoutes from "./routes/accountingReconciliation";
import exchangeRateBufferRoutes from "./routes/exchangeRateBuffers";
import adminAssetRoutes from "./routes/admin/assets";
import settingsRoutes from "./routes/settings";
import { statementsRoutes } from "./routes/statements";
import { paymentLinkRoutes } from "./routes/paymentLinkRoutes.js";
import providerStatusRouter from "./routes/providerStatus";
import { startHeartbeatService, stopHeartbeatService } from "./services/heartbeatService";
import { startStellarExporter } from "./services/stellarExporter";

// Sentry Middleware
import { initSentry, sentryBreadcrumbMiddleware } from "./middleware/sentry";
import { WebSocketManager } from "./websocket";
import { layeredCache } from "./services/layeredCache";
import { ERROR_CODES } from "./constants/errorCodes";
import { startApolloServer } from "./graphql/server";

dotenv.config();

if (process.env.SENTRY_DSN) {
  initSentry(process.env.SENTRY_DSN, process.env.SENTRY_RELEASE);
}

validateStellarNetwork();
logStellarNetwork();

const app = express();
const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = parseInt(
  process.env.SHUTDOWN_TIMEOUT_MS || "30000",
);

let server: Server | null = null;
let isShuttingDown = false;
let shutdownInProgress = false;
let activeRequests = 0;

if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// import rateLimitMiddleware from "./middleware/rateLimit"; // TODO: Commented out because the module has no default export and I don't know each middleware was .

app.use(sentryBreadcrumbMiddleware);

app.use(metricsMiddleware);
app.use(helmet());

// Compression middleware
if (process.env.COMPRESSION_ENABLED !== "false") {
  app.use(
    compression({
      threshold: parseInt(process.env.COMPRESSION_THRESHOLD || "1024"),
      level: parseInt(process.env.COMPRESSION_LEVEL || "6"),
      filter: (req, res) => {
        if (req.headers["x-no-compression"]) {
          return false;
        }
        // Don't compress already compressed content types
        const contentType = res.getHeader("content-type") as string;
        if (
          contentType &&
          (contentType.includes("image/") ||
            contentType.includes("video/") ||
            contentType.includes("audio/") ||
            contentType.includes("application/zip") ||
            contentType.includes("application/gzip"))
        ) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );
}

app.use(
  express.json({
    limit: process.env.REQUEST_SIZE_LIMIT || "10mb",
    verify: (req: IncomingMessage, _res, buf) => {
      (req as IncomingMessage & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(
  express.urlencoded({
    limit: process.env.REQUEST_SIZE_LIMIT || "10mb",
    extended: true,
  }),
);
// app.use(rateLimitMiddleware);
app.use(responseTime);
app.use(requestId);
app.use(readReplicaRoutingMiddleware);
app.use(i18nMiddleware);
app.use(dbConnectionLeakDetector);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.setHeader("Connection", "close");
    throw createError(ERROR_CODES.SERVICE_UNAVAILABLE, "Service Unavailable", {
      error: "Service Unavailable",
      message: "Server is shutting down. Please retry shortly.",
    });
  }

  activeRequests += 1;
  let completed = false;

  const onRequestFinished = () => {
    if (completed) {
      return;
    }
    completed = true;
    activeRequests = Math.max(0, activeRequests - 1);
  };

  res.on("finish", onRequestFinished);
  res.on("close", onRequestFinished);

  next();
});

const sessionSecret =
  process.env.SESSION_SECRET || "default-secret-change-in-production";
const redisStore = createRedisStore();

app.use(
  session(<SessionOptions>{
    store: redisStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: SESSION_TTL_SECONDS * 1000,
    },
  }),
);
app.use(sessionAnomalyLogger);

app.get("/health", (_req: Request, res: Response) => {
  const body: HealthCheckResponse = {
    status: "ok",
    timestamp: new Date().toISOString(),
    gitHash: process.env.BUILD_HASH,
  };
  res.json(body);
});

app.get("/ready", async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {
    database: "down",
    redis: "down",
    shutdown: isShuttingDown ? "in-progress" : "idle",
  };
  let allReady = true;

  if (isShuttingDown) {
    allReady = false;
  }

  try {
    await pool.query("SELECT 1");
    checks.database = "ok";
  } catch (err) {
    console.error("Database check failed", err);
    allReady = false;
  }

  try {
    if (redisClient?.isOpen) {
      await redisClient.ping();
      checks.redis = "ok";
    } else {
      checks.redis = "closed";
      allReady = false;
    }
  } catch (err) {
    console.error("Redis check failed", err);
    allReady = false;
  }

  const body: ReadinessCheckResponse = {
    status: allReady ? "ready" : "not ready",
    checks,
    timestamp: new Date().toISOString(),
  };
  res.status(allReady ? 200 : 503).json(body);
});

// Load Balancer Health Check
let lbHealthCache: { data: any; timestamp: number } | null = null;
const LB_HEALTH_CACHE_TTL = 5000;

app.get("/health/lb", async (req: Request, res: Response) => {
  const now = Date.now();
  if (lbHealthCache && now - lbHealthCache.timestamp < LB_HEALTH_CACHE_TTL) {
    res
      .status(lbHealthCache.data.status === "ok" ? 200 : 503)
      .json(lbHealthCache.data);
    return;
  }

  const checks: Record<string, string> = {
    database: "down",
    redis: "down",
    memory: "ok",
  };
  let healthy = true;

  if (isShuttingDown) {
    healthy = false;
  }

  try {
    await pool.query("SELECT 1");
    checks.database = "ok";
  } catch (err) {
    healthy = false;
  }

  try {
    if (redisClient?.isOpen) {
      await redisClient.ping();
      checks.redis = "ok";
    } else {
      checks.redis = "closed";
      healthy = false;
    }
  } catch (err) {
    healthy = false;
  }

  const memUsage = process.memoryUsage();
  if (memUsage.heapUsed > 1024 * 1024 * 1024) {
    // 1GB limit
    checks.memory = "high";
    healthy = false;
  }

  const responseData = {
    status: healthy ? "ok" : "error",
    checks,
    timestamp: new Date().toISOString(),
  };

  lbHealthCache = { data: responseData, timestamp: now };
  res.status(healthy ? 200 : 503).json(responseData);
});

app.use(globalTimeout);
app.use(haltOnTimedout);

app.use(apiVersionMiddleware);
app.use(validateVersionMiddleware);
app.use("/oauth", createOAuthRouter());
app.use("/api/auth", authRoutes);

app.use("/api/v1/transactions", transactionRoutesV1);
app.use("/api/v1/transactions", transactionDisputeRoutesV1);
app.use("/api/v1/transactions/bulk", bulkRoutesV1);
app.use("/api/v1/disputes", disputeRoutesV1);
app.use("/api/v1/stats", statsRoutesV1);
app.use("/api/v1/vaults", vaultRoutesV1);
app.use("/api/v1/compliance/travel-rule", travelRuleRoutes);

app.use(
  "/api/transactions",
  (req: VersionedRequest, res, next) => {
    req.apiVersion = "v1";
    res.setHeader("API-Version", "v1");
    res.setHeader("Deprecation", "true");
    res.setHeader(
      "Sunset",
      new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toUTCString(),
    );
    res.setHeader(
      "Url",
      `https://example.com${req.originalUrl.replace("/api/", "/api/v1/")}`,
    );
    next();
  },
  transactionRoutes,
);
app.use("/api/transactions", transactionDisputeRoutes);
app.use("/api/transactions/bulk", bulkRoutes);
app.use("/api/disputes", disputeRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/contacts", contactsRoutes);
app.use("/api/mtn", mtnCallbacksRouter);
app.use("/api/orange-madagascar", orangeMadagascarCallbacksRouter);
app.use("/api/reports", reportsRoutes);
app.use("/api/fees", feesRoutes);
app.use("/api/users", userRoutes);
app.use("/api/kyc", createKYCRoutes(pool));
app.use("/api/fee-strategies", feeStrategiesRouter);
app.use("/api/cross-chain", crossChainRouter);
app.use("/api/stellar", stellarRouter);
app.use("/api/reconciliation", reconciliationRoutes);
app.use("/api/exchange-rate-buffers", exchangeRateBufferRoutes);
app.use("/api/admin/assets", adminAssetRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/statements", statementsRoutes);
app.use("/", paymentLinkRoutes);

// GDPR
app.use("/api/gdpr", privacyRoutes);
app.use("/api/developer", developerDashboardRoutes);
app.use("/api/admin", requireAuth, adminRoutes);
app.use("/api/admin/providers/status", requireAuth, providerStatusRouter);
app.use("/api/admin/kyc-upgrades", requireAuth, kycTierUpgradeRoutes);
app.use("/api/admin/auth", createAdminSep10Router());
app.use("/sep10", createSep10Router());
app.use("/sep31", sep31Router);
app.use("/sep24", sep24Router);
app.use("/sep38", sep38Router);
app.use("/sep12", createSep12Router(pool));
app.use("/sep30", sep30Routes);
app.use("/.well-known/stellar.toml", tomlRouter);

// Prometheus Metrics Scraper Endpoint
app.get("/metrics", async (req: Request, res: Response) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (ex) {
    res.status(500).end(String(ex));
  }
});

app.use(
  (
    err: Error & { type?: string },
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (err.type === "entity.too.large") {
      throw createError(ERROR_CODES.LIMIT_EXCEEDED, "Payload Too Large", {
        error: "Payload Too Large",
        message: `Request exceeds the maximum size of ${process.env.REQUEST_SIZE_LIMIT || "10mb"}`,
      });
    }

    next(err);
  },
);

if (process.env.SENTRY_DSN) {
  app.use(Sentry.expressErrorHandler());
}

app.use(timeoutErrorHandler);
app.use(errorHandler);

function waitForActiveRequests(timeoutMs: number): Promise<void> {
  if (activeRequests === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (activeRequests === 0 || Date.now() - startedAt >= timeoutMs) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
  });
}

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownInProgress) {
    console.log(`[Shutdown] ${signal} received; shutdown already in progress`);
    return;
  }

  shutdownInProgress = true;
  isShuttingDown = true;
  console.log(`[Shutdown] Received ${signal}. Starting graceful shutdown...`);

  try {
    if (server) {
      console.log(
        "[Shutdown] Stopping HTTP server from accepting new requests",
      );
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      console.log("[Shutdown] HTTP listener closed");
    }

    const pendingAtStart = activeRequests;
    if (pendingAtStart > 0) {
      console.log(
        `[Shutdown] Waiting for ${pendingAtStart} active request(s) to finish (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`,
      );
    }

    await waitForActiveRequests(SHUTDOWN_TIMEOUT_MS);

    if (activeRequests > 0) {
      console.warn(
        `[Shutdown] Timed out waiting for active requests. Remaining: ${activeRequests}`,
      );
    } else {
      console.log("[Shutdown] All active requests finished");
    }

    console.log("[Shutdown] Draining queue resources");
    const { shutdownQueue } = await import("./queue/index.js");
    await shutdownQueue();
    console.log("[Shutdown] Queue resources closed");

    console.log("[Shutdown] Stopping heartbeat service");
    stopHeartbeatService();
    console.log("[Shutdown] Heartbeat service stopped");

    console.log("[Shutdown] Closing PostgreSQL pool");
    await pool.end();
    console.log("[Shutdown] PostgreSQL pool closed");

    console.log("[Shutdown] Closing Redis client");
    await disconnectRedis();
    console.log("[Shutdown] Redis client closed");

    console.log("[Shutdown] Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    console.error("[Shutdown] Shutdown sequence failed", error);
    process.exit(1);
  }
}

process.once("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

export let wsManager: WebSocketManager | null = null;

async function initializeRuntime(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  // Initialize background jobs and monitoring
  const { startJobs } = await import("./jobs/scheduler.js");
  startJobs();

  // Initialize Prometheus Horizon Scraper
  startStellarExporter();

  // Initialize System Heartbeat Metric
  startHeartbeatService();

  const { getQueueHealth, pauseQueueEndpoint, resumeQueueEndpoint } =
    await import("./queue/health.js");
  const { queueDepthHandler, queueDepthPrometheusHandler } =
    await import("./queue/queueDepthMetrics.js");

  app.get("/health/queue", getQueueHealth);
  app.get("/health/queue/depth", queueDepthHandler);
  app.get("/metrics/queue_depth", queueDepthPrometheusHandler);
  app.post("/admin/queues/pause", pauseQueueEndpoint);
  app.post("/admin/queues/resume", resumeQueueEndpoint);

  try {
    await connectRedis();
    console.log("Redis initialized");

    await layeredCache.init();
    console.log("Layered cache (L1/L2) initialized");

    const { providerSettingsService } = await import("./services/providerSettingsService.js");
    await providerSettingsService.getAllSettings();
    console.log("Provider settings cache initialized");

    const {
      startProviderBalanceAlertWorker,
      scheduleProviderBalanceAlertJob,
      startAccountingTokenRefreshWorker,
      startWebhookRetryWorker,
    } = await import("./queue/index.js");
    startProviderBalanceAlertWorker();
    startAccountingTokenRefreshWorker();
    startWebhookRetryWorker();
    await scheduleProviderBalanceAlertJob();
    console.log("Provider balance alert queue initialized");
  } catch (err) {
    console.error("Redis failed", err);
    console.warn("Distributed locks not available");
  }

  const { createQueueDashboard } = await import("./queue/dashboard.js");
  app.use("/admin/queues", createQueueDashboard());

  //
  const useHTTP2 = process.env.USE_HTTP2 === "true";

  if (useHTTP2) {
    const sslOptions = {
      key: fs.readFileSync(path.join(__dirname, "../certs/key.pem")),
      cert: fs.readFileSync(path.join(__dirname, "../certs/cert.pem")),
    };

    const http2Server = spdy.createServer(sslOptions, app);
    http2Server.listen(PORT, () => {
      console.log(`HTTP/2 server running on https://localhost:${PORT}`);
    });
    server = http2Server as unknown as Server;
  } else {
    server = app.listen(PORT, () => {
      console.log(`HTTP/1.1 server running on http://localhost:${PORT}`);
    });

    wsManager = new WebSocketManager(server);
    console.log("WebSocket server attached");

    // Start Apollo Server with APQ enabled (must run after HTTP server is created)
    await startApolloServer(app, server);
    console.log("Apollo GraphQL server started at /graphql");
  }
}

if (process.env.NODE_ENV !== "test") {
  void initializeRuntime();
}

export default app;