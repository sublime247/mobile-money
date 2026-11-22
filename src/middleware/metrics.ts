import { Request, Response, NextFunction } from "express";
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  httpRequestDurationSummary,
  activeConnections,
} from "../utils/metrics";

export const metricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const start = process.hrtime();

  // Increment active connections
  activeConnections.inc();

  res.on("finish", () => {
    // Decrement active connections
    activeConnections.dec();

    const duration = process.hrtime(start);
    const durationSeconds = duration[0] + duration[1] / 1e9;

    // Get route (or fallback to path)
    const route = req.route ? req.route.path : req.path;
    const labels = {
      method: req.method,
      route: route,
      status_code: res.statusCode.toString(),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
    httpRequestDurationSummary.observe(labels, durationSeconds);
  });

  next();
};
