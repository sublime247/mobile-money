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

// Horizon node rotation / failover metrics
export const horizonNodeFailuresTotal = new Counter({
  name: "horizon_node_failures_total",
  help: "Total number of failed Horizon requests, labelled per node",
  labelNames: ["node", "error_type"],
  registers: [register],
});

export const horizonNodeHealth = new Gauge({
  name: "horizon_node_health",
  help: "Current Horizon node health (1=in rotation, 0=removed/cooldown)",
  labelNames: ["node"],
  registers: [register],
});

export const horizonRequestFailoverTotal = new Counter({
  name: "horizon_request_failover_total",
  help: "Total number of Horizon requests retried on an alternative node",
  labelNames: ["from_node", "to_node", "operation"],
  registers: [register],
});

export const healthCheckResponseTimeSeconds = new Histogram({
  name: "health_check_response_time_seconds",
  help: "Duration of provider health checks in seconds",
  labelNames: ["provider", "status"],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 3, 5, 10],
  registers: [register],
});

// Batch Payout Metrics
export const batchPayoutTotal = new Counter({
  name: "batch_payout_total",
  help: "Total number of batch payout operations",
  labelNames: ["provider", "status"],
  registers: [register],
});

export const batchPayoutItemsTotal = new Counter({
  name: "batch_payout_items_total",
  help: "Total number of items processed in batch payouts",
  labelNames: ["provider", "status"],
  registers: [register],
});

export const batchPayoutDurationSeconds = new Histogram({
  name: "batch_payout_duration_seconds",
  help: "Duration of batch payout operations in seconds",
  labelNames: ["provider"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const batchPayoutSize = new Histogram({
  name: "batch_payout_size",
  help: "Number of items in each batch payout",
  labelNames: ["provider"],
  buckets: [1, 5, 10, 20, 30, 40, 50],
  registers: [register],
});

// Connection Metrics
export const activeConnections = new Gauge({
  name: "active_connections",
  help: "Number of active HTTP connections",
  registers: [register],
});

export const dbReplicaLagSeconds = new Gauge({
  name: "db_replica_lag_seconds",
  help: "Replication lag in seconds for each read replica",
  labelNames: ["replica_url"],
  registers: [register],
});

export const dbReplicaReadEnabled = new Gauge({
  name: "db_replica_read_enabled",
  help: "Whether the replica is currently enabled for read routing (1=enabled, 0=disabled)",
  labelNames: ["replica_url"],
  registers: [register],
});

export { register };

// Cache Metrics
export const cacheHitsTotal = new Counter({
  name: "cache_hits_total",
  help: "Total number of cache hits",
  labelNames: ["route"],
  registers: [register],
});

export const cacheMissesTotal = new Counter({
  name: "cache_misses_total",
  help: "Total number of cache misses",
  labelNames: ["route"],
  registers: [register],
});

// A gauge that mirrors the hit ratio for easier scraping; updated on each hit/miss
export const cacheHitRatio = new Gauge({
  name: "cache_hit_ratio",
  help: "Cache hit ratio (hits / (hits+misses))",
  labelNames: ["route"],
  registers: [register],
});

// Cross-Chain Asset Monitoring Metrics
export const crossChainBalanceGauge = new Gauge({
  name: "cross_chain_balance",
  help: "Current asset balance per chain/address",
  labelNames: ["chain", "asset", "address"],
  registers: [register],
});

export const crossChainAnomalyTotal = new Counter({
  name: "cross_chain_anomaly_total",
  help: "Number of cross-chain balance anomalies detected",
  labelNames: ["chain", "asset", "reason"],
  registers: [register],
});

// System Heartbeat Metric
export const systemHeartbeat = new Gauge({
  name: "system_heartbeat",
  help: "System heartbeat metric indicating baseline availability state (1=available, 0=unavailable)",
  labelNames: ["service"],
  registers: [register],
});
