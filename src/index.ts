import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

import { transactionRoutes } from "./routes/transactions";
import { bulkRoutes } from "./routes/bulk";
import { transactionDisputeRoutes, disputeRoutes } from "./routes/disputes";
import { statsRoutes } from "./routes/stats";
import { errorHandler } from "./middleware/errorHandler";
import { connectRedis, redisClient } from "./config/redis";
import { pool } from "./config/database";
import {
  globalTimeout,
  haltOnTimedout,
  timeoutErrorHandler,
} from "./middleware/timeout";
import { responseTime } from "./middleware/responseTime";
import {
  createQueueDashboard,
  getQueueHealth,
  pauseQueueEndpoint,
  resumeQueueEndpoint,
} from "./queue";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { startJobs } from "./jobs/scheduler";

import { register } from "./utils/metrics";
import { metricsMiddleware } from "./middleware/metrics";
import { HealthCheckResponse, ReadinessCheckResponse } from "./types/api";

dotenv.config();

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

// Middleware
app.use(metricsMiddleware);
app.use(helmet());
app.use(cors());

// --- Updated: JSON body parser with size limit ---
app.use(
  express.json({
    limit: process.env.REQUEST_SIZE_LIMIT || "10mb", // Default 10mb
  }),
);

// --- Optional: urlencoded parser with same limit ---
app.use(
  express.urlencoded({
    limit: process.env.REQUEST_SIZE_LIMIT || "10mb",
    extended: true,
  }),
);
app.use(limiter);
app.use(responseTime);

// Health & readiness
app.get("/health", (req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() }),
);

// Basic health check
app.get("/health", (req, res) => {
  const body: HealthCheckResponse = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
  res.json(body);
});

/**
 * Readiness probe (DB + Redis)
 */
app.get("/ready", async (req, res) => {
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

  const response: ReadinessCheckResponse = {
    status: allReady ? "ready" : "not ready",
    checks,
    timestamp: new Date().toISOString(),
  };
  res.status(allReady ? 200 : 503).json(response);
});

// Timeout middleware
app.use(globalTimeout);
app.use(haltOnTimedout);

// Routes
app.use("/api/transactions", transactionRoutes);
app.use("/api/transactions", transactionDisputeRoutes);
app.use("/api/transactions/bulk", bulkRoutes);
app.use("/api/disputes", disputeRoutes);
app.use("/api/stats", statsRoutes);

// Queue endpoints
app.get("/health/queue", getQueueHealth);
app.post("/admin/queues/pause", pauseQueueEndpoint);
app.post("/admin/queues/resume", resumeQueueEndpoint);

// Global handler for payload too large
app.use(
  (
    err: Error & { type?: string },
    req: Request,
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

// Error handlers
app.use(timeoutErrorHandler);
app.use(errorHandler);

// Redis init
connectRedis()
  .then(() => {
    // Only log if not in test mode to keep test output clean
    if (process.env.NODE_ENV !== 'test') {
      console.log("Redis initialized");
    }
  })
  .catch((err) => {
    console.error("Redis failed", err);
    console.warn("Distributed locks not available");
  });

// Queue dashboard
const queueRouter = createQueueDashboard();
app.use("/admin/queues", queueRouter);

// --- START SERVER LOGIC ---
// We check if we are in a test environment to prevent port collisions
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Export the app instance for Supertest integration tests
export default app;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `Rate limit: ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s`,
  );
});

export default app;
