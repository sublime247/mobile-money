import { Request, Response } from "express";
import { transactionQueue, getQueueStats } from "./transactionQueue";
import { QueueHealthResponse, QueueActionResponse } from "../types/api";

export async function getQueueHealth(req: Request, res: Response) {
  try {
    const stats = await getQueueStats();

    const isHealthy = !stats.isPaused && stats.failed < 100;

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
    console.error("Failed to fetch queue health:", err);
    res.status(500).json({ error: "Failed to fetch queue health" });
  }
}

export async function pauseQueueEndpoint(req: Request, res: Response) {
  try {
    await transactionQueue.pause();
    const body: QueueActionResponse = {
      success: true,
      message: "Queue paused",
    };
    res.json(body);
  } catch (err) {
    console.error("Failed to pause queue:", err);
    res.status(500).json({ error: "Failed to pause queue" });
  }
}

export async function resumeQueueEndpoint(req: Request, res: Response) {
  try {
    await transactionQueue.resume();
    const body: QueueActionResponse = {
      success: true,
      message: "Queue resumed",
    };
    res.json(body);
  } catch (err) {
    console.error("Failed to resume queue:", err);
    res.status(500).json({ error: "Failed to resume queue" });
  }
}
