import { Request, Response } from "express";
import { providerBalanceAlertQueue } from "./providerBalanceAlertQueue";
import { accountMergeQueue } from "./accountMergeQueue";
import { getQueueStats } from "./transactionQueue";
import { redisClient } from "../config/redis";
import { Queue } from "bullmq";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

export interface QueueDepthMetrics {
  queues: {
    name: string;
    waiting: number;
    active: number;
    depth: number; // waiting + active — the value KEDA scales on
    latency_ms: number; // average age of the first 5 waiting jobs
  }[];
  total_depth: number;
  redis_memory_bytes: number;
  timestamp: string;
}

async function getLatency(queue: Queue): Promise<number> {
  try {
    const jobs = await queue.getWaiting(0, 4); // Peek first 5 waiting jobs
    if (jobs.length === 0) return 0;
    const now = Date.now();
    const totalAge = jobs.reduce((sum, job) => sum + (now - job.timestamp), 0);
    return Math.floor(totalAge / jobs.length);
  } catch {
    return 0;
  }
}

/**
 * Aggregate queue depth and performance metrics across all BullMQ queues.
 */
export async function getQueueStatsAggregate(): Promise<QueueDepthMetrics> {
  const [
    txStats,
    providerWaiting,
    providerActive,
    mergeWaiting,
    mergeActive,
    providerLatency,
    mergeLatency,
    redisInfo,
  ] = await Promise.all([
    getQueueStats(),
    providerBalanceAlertQueue.getWaitingCount(),
    providerBalanceAlertQueue.getActiveCount(),
    accountMergeQueue.getWaitingCount(),
    accountMergeQueue.getActiveCount(),
    getLatency(providerBalanceAlertQueue as any), // Cast if needed for compatibility
    getLatency(accountMergeQueue),
    redisClient.info("memory"),
  ]);

  // Parse Redis memory info
  const memoryMatch = String(redisInfo).match(/used_memory:(\d+)/);
  const redis_memory_bytes = memoryMatch ? parseInt(memoryMatch[1], 10) : 0;

  const queues = [
    {
      name: "transaction-processing",
      waiting: txStats.waiting,
      active: txStats.active,
      depth: txStats.waiting + txStats.active,
      latency_ms: 0, // Not easily peekable for RabbitMQ without more setup
    },
    {
      name: "provider-balance-alerts",
      waiting: providerWaiting,
      active: providerActive,
      depth: providerWaiting + providerActive,
      latency_ms: providerLatency,
    },
    {
      name: "account-merge",
      waiting: mergeWaiting,
      active: mergeActive,
      depth: mergeWaiting + mergeActive,
      latency_ms: mergeLatency,
    },
  ];

  const total_depth = queues.reduce((sum, q) => sum + q.depth, 0);

  return {
    queues,
    total_depth,
    redis_memory_bytes,
    timestamp: new Date().toISOString(),
  };
}

/**
 * GET /health/queue/depth
 * Returns queue depth as JSON — consumed by KEDA's HTTP external scaler
 * and also useful for dashboards / alerting.
 */
export async function queueDepthHandler(req: Request, res: Response) {
  try {
    const metrics = await getQueueStatsAggregate();
    res.json(metrics);
  } catch (err) {
    console.error("Failed to fetch queue depth:", err);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to fetch queue depth",
      {
        error: "Failed to fetch queue depth",
      },
    );
  }
}

/**
 * GET /metrics/queue_depth  (Prometheus text format)
 * Exposes queue_depth gauge so Prometheus + KEDA external metrics adapter
 * can scrape it without a separate exporter.
 */
export async function queueDepthPrometheusHandler(req: Request, res: Response) {
  try {
    const metrics = await getQueueStatsAggregate();

    const lines: string[] = [
      "# HELP queue_depth Number of waiting + active jobs in each BullMQ queue",
      "# TYPE queue_depth gauge",
    ];

    for (const q of metrics.queues) {
      lines.push(`queue_depth{queue="${q.name}"} ${q.depth}`);
    }

    lines.push(
      "# HELP queue_latency_ms Average age of waiting jobs in milliseconds",
      "# TYPE queue_latency_ms gauge",
    );

    for (const q of metrics.queues) {
      lines.push(`queue_latency_ms{queue="${q.name}"} ${q.latency_ms}`);
    }

    lines.push(
      "# HELP queue_depth_total Total pending jobs across all queues",
      "# TYPE queue_depth_total gauge",
      `queue_depth_total ${metrics.total_depth}`,
      "# HELP redis_memory_usage_bytes Current Redis memory usage in bytes",
      "# TYPE redis_memory_usage_bytes gauge",
      `redis_memory_usage_bytes ${metrics.redis_memory_bytes}`,
    );

    res
      .set("Content-Type", "text/plain; version=0.0.4")
      .send(lines.join("\n") + "\n");
  } catch (err) {
    console.error("Failed to expose queue depth metrics:", err);
    res.status(500).send("# error fetching queue depth\n");
  }
}
