import { Router, Request, Response } from "express";
import { register } from "../utils/metrics";
import {
  createMetricsAuthMiddleware,
  MetricsAuthOptions,
} from "../middleware/metricsAuth";

export interface MetricsRouterOptions extends MetricsAuthOptions {}

const createMetricsRouter = (options?: MetricsRouterOptions) => {
  const router = Router();

  // Protect /metrics with Basic Auth and/or internal network IP restrictions (#1994)
  router.use(createMetricsAuthMiddleware(options));

  /**
   * GET /metrics
   *
   * Exposes all registered Prometheus metrics in the standard plain-text
   * Prometheus exposition format (text/plain; version=0.0.4).
   *
   * Includes:
   *   - transactions_total{provider, status, currency}
   *   - http_request_duration_seconds (histogram buckets for p50, p95, p99)
   *   - http_request_duration_summary_seconds (percentiles p50, p95, p99)
   *   - CPU, memory, event loop, and queue depth metrics
   */
  router.get("/", async (_req: Request, res: Response) => {
    try {
      const metrics = await register.metrics();
      res
        .set("Content-Type", register.contentType)
        .send(metrics);
    } catch (err) {
      res.status(500).send("# error collecting metrics\n");
    }
  });

  return router;
};

export { createMetricsRouter };
