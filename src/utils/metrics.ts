import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  Summary,
  collectDefaultMetrics,
} from "prom-client";

const register = new Registry();

// Add default metrics (CPU, Memory, etc.)
collectDefaultMetrics({ register });

// HTTP Metrics
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10], // standard buckets
  registers: [register],
});

// Business Logic Metrics
export const transactionTotal = new Counter({
  name: "transaction_total",
  help: "Total number of transactions processed",
  labelNames: ["type", "provider", "status"], // type: payment/payout
  registers: [register],
});

export const transactionErrorsTotal = new Counter({
  name: "transaction_errors_total",
  help: "Total number of transaction errors",
  labelNames: ["type", "provider", "error_type"],
  registers: [register],
});

export const providerResponseTimeSeconds = new Histogram({
  name: "provider_response_time_seconds",
  help: "Duration of provider operations in seconds",
  labelNames: ["provider", "operation", "status"],
  buckets: [0.1, 0.3, 0.5, 1, 3, 5, 10, 30],
  registers: [register],
});

export const providerResponseTimeSummary = new Summary({
  name: "provider_response_time_summary",
  help: "Summary of provider operation durations in seconds",
  labelNames: ["provider", "operation"],
  percentiles: [0.5, 0.9, 0.95, 0.99],
  registers: [register],
});

// Failover metrics
export const providerFailoverTotal = new Counter({
  name: "provider_failover_total",
  help: "Total number of automatic provider failovers",
  labelNames: ["type", "from_provider", "to_provider", "reason"],
  registers: [register],
});

export const providerFailoverAlerts = new Counter({
  name: "provider_failover_alerts_total",
  help: "Number of failover alert notifications emitted",
  labelNames: ["provider"],
  registers: [register],
});

export const providerCircuitBreakerTransitionsTotal = new Counter({
  name: "provider_circuit_breaker_transitions_total",
  help: "Total number of provider circuit breaker state transitions",
  labelNames: ["provider", "operation", "state"],
  registers: [register],
});

export const providerCircuitBreakerState = new Gauge({
  name: "provider_circuit_breaker_state",
  help: "Current provider circuit breaker state (0=closed, 0.5=half_open, 1=open)",
  labelNames: ["provider", "operation"],
  registers: [register],
});

export const healthCheckResponseTimeSeconds = new Histogram({
  name: "health_check_response_time_seconds",
  help: "Duration of provider health checks in seconds",
  labelNames: ["provider", "status"],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 3, 5, 10],
  registers: [register],
});

// Connection Metrics
export const activeConnections = new Gauge({
  name: "active_connections",
  help: "Number of active HTTP connections",
  registers: [register],
});

export { register };
