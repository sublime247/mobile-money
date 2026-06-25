import logger from "../utils/logger";
import { Request, Response } from "express";
import { getQueueStats, pauseQueue, resumeQueue } from "./transactionQueue";
import { providerBalanceAlertQueue } from "./providerBalanceAlertQueue";
import { QueueHealthResponse, QueueActionResponse } from "../types/api";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

export async function getQueueHealth(req: Request, res: Response) {
  try {
    const [stats, providerBalanceFailed] = await Promise.all([
      getQueueStats(),
      providerBalanceAlertQueue.getFailedCount(),
    ]);

    const isHealthy =
      !stats.isPaused && stats.failed < 100 && providerBalanceFailed < 20;

    const body: QueueHealthResponse = {
      status: isHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      queue: "transaction-processing",
      stats: {
        waiting: stats.waiting,
        active: stats.active,
        completed: stats.completed,
        failed: stats.failed,
        paused: stats.isPaused,
      },
    };
    res.json(body);
  } catch (err) {
    logger.error("Failed to fetch queue health:", err);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch queue health");
  }
}

export async function pauseQueueEndpoint(req: Request, res: Response) {
  try {
    await pauseQueue();
    const body: QueueActionResponse = {
      success: true,
      message: "Queue paused",
    };
    res.json(body);
  } catch (err) {
    logger.error("Failed to pause queue:", err);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to pause queue");
  }
}

export async function resumeQueueEndpoint(req: Request, res: Response) {
  try {
    await resumeQueue();
    const body: QueueActionResponse = {
      success: true,
      message: "Queue resumed",
    };
    res.json(body);
  } catch (err) {
    logger.error("Failed to resume queue:", err);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to resume queue");
  }
}