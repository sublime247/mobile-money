import "./tracer";
import express, { NextFunction, Request, Response } from "express";
import { IncomingMessage, Server } from "http";
import cors from "cors";
import helmet from "helmet";
// replaced express-rate-limit with our redis-backed middleware
import compression from "compression";
import dotenv from "dotenv";

import https from "https";
import fs from "fs";
import path from "path";
import session from "express-session";
import * as Sentry from "@sentry/node";

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
import { statementsRoutes } from "./routes/statements";
import { createKYCRoutes } from "./routes/kycRoutes";
import { vaultRoutes } from "./routes/vaults";
import { adminRoutes } from "./routes/admin";
import { makerCheckerRoutes } from "./routes/makerChecker";
import { userRoutes } from "./routes/users";
import { authRoutes } from "./routes/auth";
import { errorHandler } from "./middleware/errorHandler";
import {
  connectRedis,
  disconnectRedis,
  redisClient,
  createRedisStore,
  SESSION_TTL_SECONDS,
} from "./config/redis";
import { createCorsOptions } from "./config/cors";
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
import { i18nMiddleware } from "./utils/i18n";
import { metricsMiddleware } from "./middleware/metrics";
import { validateStellarNetwork, logStellarNetwork } from "./config/stellar";
import { sessionAnomalyLogger } from "./services/logger";
import { HealthCheckResponse, ReadinessCheckResponse } from "./types/api";
import { privacyRoutes } from "./routes/privacy";
import sep31Router from "./stellar/sep31";
import sep24Router from "./stellar/sep24";
import { createSep12Router } from "./stellar/sep12";
import { createSep10Router } from "./stellar/sep10";
import tomlRouter from "./routes/toml";

// 1. Import Sentry Middleware
import { initSentry, sentryBreadcrumbMiddleware } from "./middleware/sentry";
import { WebSocketManager } from "./websocket";

dotenv.config();

if (process.env.SENTRY_DSN) {
  initSentry(process.env.SENTRY_DSN);
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

import rateLimitMiddleware from "./middleware/rateLimit";

app.use(sentryBreadcrumbMiddleware);

app.use(metricsMiddleware);
app.use(helmet());

if (process.env.COMPRESSION_ENABLED !== "false") {
  app.use(
    compression({
      threshold: parseInt(process.env.COMPRESSION_THRESHOLD || "1024"),
      level: parseInt(process.env.COMPRESSION_LEVEL || "6"),
      filter: (req, res) => {
        if (req.headers["x-no-compression"]) {
          return false;
        }
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

app.use(cors(createCorsOptions()));
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
app.use(rateLimitMiddleware);
app.use(responseTime);
app.use(requestId);
app.use(i18nMiddleware);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.setHeader("Connection", "close");
    return res.status(503).json({
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
  session({
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
let lbHealthCache: { data: any, timestamp: number } | null = null;
const LB_HEALTH_CACHE_TTL = 5000;

app.get("/health/lb", async (req: Request, res: Response) => {
  const now = Date.now();
  if (lbHealthCache && (now - lbHealthCache.timestamp < LB_HEALTH_CACHE_TTL)) {
    res.status(lbHealthCache.data.status === "ok" ? 200 : 503).json(lbHealthCache.data);
    return;
  }

  const checks: Record<string, string> = {
    database: "down",
    redis: "down",
    memory: "ok"
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
  if (memUsage.heapUsed > 1024 * 1024 * 1024) { // 1GB limit
    checks.memory = "high";
    healthy = false;
  }

  const responseData = {
    status: healthy ? "ok" : "error",
    checks,
    timestamp: new Date().toISOString()
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
app.use("/api/auth", authRoutes);
app.use("/api/v1/transactions", transactionDisputeRoutesV1);
app.use("/api/v1/transactions/bulk", bulkRoutesV1);
app.use("/api/v1/disputes", disputeRoutesV1);
app.use("/api/v1/stats", statsRoutesV1);
app.use("/api/v1/vaults", vaultRoutesV1);

const deprecatedApiV1Handler: express.RequestHandler = (req, res, next) => {
  const versionedReq = req as VersionedRequest;
  versionedReq.apiVersion = "v1";
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
};

app.use("/api/transactions", deprecatedApiV1Handler, transactionRoutes);
app.use("/api/transactions", transactionDisputeRoutes);
app.use("/api/transactions/bulk", bulkRoutes);
app.use("/api/disputes", disputeRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/contacts", contactsRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/statements", statementsRoutes);
app.use("/api/users", userRoutes);
app.use("/api/kyc", createKYCRoutes(pool));

// GDPR
app.use("/api/gdpr", privacyRoutes);
app.use("/api/admin", requireAuth, adminRoutes);
app.use("/sep10", createSep10Router());
app.use("/sep31", sep31Router);
app.use("/sep24", sep24Router);
app.use("/sep12", createSep12Router(pool));
app.use("/sep10", createSep10Router());
app.use("/.well-known/stellar.toml", tomlRouter);

app.use(
  (
    err: Error & { type?: string },
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (err.type === "entity.too.large") {
      return res.status(413).json({
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
      console.log("[Shutdown] Stopping HTTP server from accepting new requests");
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
    const { shutdownQueue } = await import("./queue");
    await shutdownQueue();
    console.log("[Shutdown] Queue resources closed");

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

  const { getQueueHealth, pauseQueueEndpoint, resumeQueueEndpoint } =
    await import("./queue/health");

  app.get("/health/queue", getQueueHealth);
  app.post("/admin/queues/pause", pauseQueueEndpoint);
  app.post("/admin/queues/resume", resumeQueueEndpoint);

  try {
    await connectRedis();
    console.log("Redis initialized");

    const { startProviderBalanceAlertWorker, scheduleProviderBalanceAlertJob } =
      await import("./queue");
    startProviderBalanceAlertWorker();
    await scheduleProviderBalanceAlertJob();
    console.log("Provider balance alert queue initialized");
  } catch (err) {
    console.error("Redis failed", err);
    console.warn("Distributed locks not available");
  }

  const { createQueueDashboard } = await import("./queue/dashboard");
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
    server = app.listen(PORT, () =>
      console.log(`HTTP/1.1 server running on http://localhost:${PORT}`),
    );

    wsManager = new WebSocketManager(server);
    console.log("WebSocket server attached");
  }
}

if (process.env.NODE_ENV !== "test") {
  void initializeRuntime();
}

export default app;
