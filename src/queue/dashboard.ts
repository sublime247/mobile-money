import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Queue } from "bullmq";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

import { transactionQueue } from "./transactionQueue";
import { deadLetterQueue } from "./dlq";
import { syncQueue } from "./syncQueue";
import { refundQueue } from "./refundWorker";
import { webhookRetryQueue } from "./webhookRetryQueue";
import { accountMergeQueue } from "./accountMergeQueue";
import { providerBalanceAlertQueue } from "./providerBalanceAlertQueue";
import { callbackQueue } from "./callbackQueue";

export interface QueueDashboardAuthOptions {
  username?: string;
  password?: string;
  enabled?: boolean;
}

/**
 * Basic Authentication middleware for Bull-Board dashboard.
 */
export function createDashboardAuthMiddleware(options: QueueDashboardAuthOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // If explicitly disabled via env, skip auth (useful for local dev or internal test environments)
    if (process.env.BULL_BOARD_AUTH_DISABLED === "true") {
      next();
      return;
    }

    const expectedUser =
      options.username ??
      process.env.BULL_BOARD_USER ??
      process.env.ADMIN_USER ??
      "admin";
    const expectedPassword =
      options.password ??
      process.env.BULL_BOARD_PASSWORD ??
      process.env.ADMIN_PASSWORD ??
      "admin";

    const authHeader = req.headers.authorization;

    // Also support Bearer JWT token if sent by authenticated admin clients
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7).trim();
        // Allow valid Bearer tokens matching JWT or ADMIN_API_KEY
        if (
          process.env.ADMIN_API_KEY &&
          token === process.env.ADMIN_API_KEY
        ) {
          next();
          return;
        }
      } catch {
        // Fall back to Basic Auth check
      }
    }

    if (!authHeader || !authHeader.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Bull-Board Dashboard"');
      res.status(401).json({
        error: "Unauthorized: Bull-Board requires Basic authentication",
      });
      return;
    }

    const credentialsBase64 = authHeader.slice(6).trim();
    let credentials = "";
    try {
      credentials = Buffer.from(credentialsBase64, "base64").toString("utf-8");
    } catch {
      res.setHeader("WWW-Authenticate", 'Basic realm="Bull-Board Dashboard"');
      res.status(401).json({
        error: "Unauthorized: Invalid authorization encoding",
      });
      return;
    }

    const colonIndex = credentials.indexOf(":");
    if (colonIndex === -1) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Bull-Board Dashboard"');
      res.status(401).json({
        error: "Unauthorized: Invalid credentials format",
      });
      return;
    }

    const username = credentials.substring(0, colonIndex);
    const password = credentials.substring(colonIndex + 1);

    const userBuf = Buffer.from(username);
    const expectedUserBuf = Buffer.from(expectedUser);
    const passBuf = Buffer.from(password);
    const expectedPassBuf = Buffer.from(expectedPassword);

    const userMatch =
      userBuf.length === expectedUserBuf.length &&
      crypto.timingSafeEqual(userBuf, expectedUserBuf);
    const passMatch =
      passBuf.length === expectedPassBuf.length &&
      crypto.timingSafeEqual(passBuf, expectedPassBuf);

    if (!userMatch || !passMatch) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Bull-Board Dashboard"');
      res.status(401).json({
        error: "Unauthorized: Invalid Bull-Board credentials",
      });
      return;
    }

    next();
  };
}

/**
 * Creates the protected Bull-Board dashboard router mounted at /admin/queues.
 */
export function createQueueDashboard(basePath = "/admin/queues", authOptions?: QueueDashboardAuthOptions) {
  const router = Router();
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(basePath);

  const monitoredQueues = [
    transactionQueue,
    deadLetterQueue,
    syncQueue,
    refundQueue,
    webhookRetryQueue,
    accountMergeQueue,
    providerBalanceAlertQueue,
    callbackQueue,
  ];

  createBullBoard({
    queues: monitoredQueues.map((q) => new BullMQAdapter(q as unknown as Queue)),
    serverAdapter,
  });

  // Apply authentication middleware to all dashboard endpoints
  router.use(createDashboardAuthMiddleware(authOptions));

  // JSON metrics endpoint exposing job counters for active, waiting, completed, failed, and delayed
  router.get("/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await Promise.all(
        monitoredQueues.map(async (queue) => {
          const [waiting, active, completed, failed, delayed, isPaused] =
            await Promise.all([
              queue.getWaitingCount().catch(() => 0),
              queue.getActiveCount().catch(() => 0),
              queue.getCompletedCount().catch(() => 0),
              queue.getFailedCount().catch(() => 0),
              queue.getDelayedCount().catch(() => 0),
              queue.isPaused().catch(() => false),
            ]);

          return {
            name: queue.name,
            waiting,
            active,
            completed,
            failed,
            delayed,
            isPaused,
          };
        }),
      );

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        queues: stats,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch queue stats",
      });
    }
  });

  // Mount Bull-Board UI router
  router.use(serverAdapter.getRouter());

  return router;
}
