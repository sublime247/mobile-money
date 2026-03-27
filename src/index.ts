import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import dotenv from "dotenv";
import session from "express-session";

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
import { bulkRoutes } from "./routes/bulk";
import { transactionDisputeRoutes, disputeRoutes } from "./routes/disputes";
import { statsRoutes } from "./routes/stats";
import { contactsRoutes } from "./routes/contacts";
import { reportsRoutes } from "./routes/reports";
import { createKYCRoutes } from "./routes/kycRoutes";
import { vaultRoutes } from "./routes/vaults";
import { adminRoutes } from "./routes/admin";
import feesRouter from "./routes/fees";
import { errorHandler } from "./middleware/errorHandler";
import {
  connectRedis,
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
import { metricsMiddleware } from "./middleware/metrics";
import { validateStellarNetwork, logStellarNetwork } from "./config/stellar";
import { sessionAnomalyLogger } from "./services/logger";
import { HealthCheckResponse, ReadinessCheckResponse } from "./types/api";
import sep31Router from "./stellar/sep31";

dotenv.config();

validateStellarNetwork();
logStellarNetwork();

const app = express();
const PORT = process.env.PORT || 3000;

const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "900000",
);
const RATE_LIMIT_MAX_REQUESTS = parseInt(
  process.env.RATE_LIMIT_MAX_REQUESTS || "100",
);

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
});

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

app.use(cors(createCorsOptions()));
app.use(
  express.json({
    limit: process.env.REQUEST_SIZE_LIMIT || "10mb",
  }),
);
app.use(
  express.urlencoded({
    limit: process.env.REQUEST_SIZE_LIMIT || "10mb",
    extended: true,
  }),
);
app.use(limiter);
app.use(responseTime);
app.use(requestId);

// Session configuration with Redis store
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
  const checks: Record<string, string> = { database: "down", redis: "down" };
  let allReady = true;

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

app.use(globalTimeout);
app.use(haltOnTimedout);

app.use(apiVersionMiddleware);
app.use(validateVersionMiddleware);
app.use("/oauth", createOAuthRouter());

app.use("/api/v1/transactions", transactionRoutesV1);
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
app.use("/api/kyc", createKYCRoutes(pool));
app.use("/api/admin", requireAuth, adminRoutes);
app.use("/api/fees", feesRouter);
app.use("/sep31", sep31Router);

// SEP-24 Interactive Deposit/Withdrawal Flow
app.use("/sep24", sep24Router);

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

app.use(timeoutErrorHandler);
app.use(errorHandler);

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
  } catch (err) {
    console.error("Redis failed", err);
    console.warn("Distributed locks not available");
  }

  const { createQueueDashboard } = await import("./queue/dashboard");
  app.use("/admin/queues", createQueueDashboard());

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

if (process.env.NODE_ENV !== "test") {
  void initializeRuntime();
}

export default app;
