import { Router, Request, Response } from "express";
import { register } from "../utils/metrics";
import { Registry } from "prom-client";
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
   * Prometheus exposition format (text/plain; version=0.0.4) or OpenMetrics
   * format (application/openmetrics-text; version=1.0.0) based on Accept header
   * or configuration (#1994, #2170).
   *
   * Includes:
   *   - transactions_total{provider, status, currency}
   *   - momo_provider_request_duration_seconds{provider, operation}
   *   - momo_provider_errors_total{provider, error_type}
   *   - http_request_duration_seconds (histogram buckets for p50, p95, p99)
   *   - http_request_duration_summary_seconds (percentiles p50, p95, p99)
   *   - CPU, memory, event loop, and queue depth metrics
   */
  router.get("/", async (req: Request, res: Response) => {
    try {
      const isExplicitOpenMetrics =
        process.env.METRICS_OPENMETRICS === "true" ||
        (typeof req.headers.accept === "string" &&
          req.headers.accept.includes("application/openmetrics-text"));

      if (isExplicitOpenMetrics) {
        (register as any).setContentType?.(Registry.OPENMETRICS_CONTENT_TYPE);
      } else {
        (register as any).setContentType?.(Registry.PROMETHEUS_CONTENT_TYPE);
      }

      const metrics = await register.metrics();
      const contentType = isExplicitOpenMetrics
        ? Registry.OPENMETRICS_CONTENT_TYPE
        : register.contentType;

      res.set("Content-Type", contentType).send(metrics);
    } catch (err) {
      res.status(500).send("# error collecting metrics\n");
    }
  });

  return router;
};

export { createMetricsRouter };
