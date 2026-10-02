import {
  Registry,
  RegistryContentType,
  Counter,
  Histogram,
  Gauge,
  Summary,
  collectDefaultMetrics,
} from "prom-client";

const register = new Registry();

// Exemplars (trace_id / span_id attached to latency histograms) are only
// serialized in the OpenMetrics exposition format. Opt-in because it changes
// the /metrics content type from text/plain 0.0.4 to application/openmetrics-text.
if (process.env.METRICS_OPENMETRICS === "true") {
  // prom-client types `Registry` as Prometheus-text by default; the runtime
  // accepts either content type.
  (register as unknown as Registry<RegistryContentType>).setContentType(
    Registry.OPENMETRICS_CONTENT_TYPE,
  );
}

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
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], // standard latency buckets
  registers: [register],
});

export const httpRequestDurationSummary = new Summary({
  name: "http_request_duration_summary_seconds",
  help: "Summary of HTTP request durations with p50, p95, and p99 percentiles",
  labelNames: ["method", "route", "status_code"],
  percentiles: [0.5, 0.95, 0.99],
  registers: [register],
});

// Business Logic Metrics
export const transactionsTotal = new Counter({
  name: "transactions_total",
  help: "Total number of transactions processed",
  labelNames: ["provider", "status", "currency"],
  registers: [register],
});

export const transactionTotal = new Counter({
  name: "transaction_total",
  help: "Total number of transactions processed",
  labelNames: ["type", "provider", "status"], // type: payment/payout
  registers: [register],
});

export const activeTransactions = new Gauge({
  name: "active_transactions",
  help: "Current number of active transactions being processed",
  labelNames: ["provider"],
  registers: [register],
});

export interface RecordTransactionParams {
  provider: string;
  status: string;
  currency: string;
  count?: number;
}

export function recordTransactionMetrics({
  provider,
  status,
  currency,
  count = 1,
}: RecordTransactionParams): void {
  transactionsTotal.inc({ provider, status, currency }, count);
  // Also keep backward-compatible transactionTotal updated
  transactionTotal.inc({ type: "payment", provider, status }, count);
}

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

export const CIRCUIT_BREAKER_STATE_VALUES = {
  closed: 0,
  half_open: 0.5,
  open: 1,
} as const;

export function recordCircuitBreakerTransition(
  provider: string,
  operation: string,
  state:
    | "closed"
    | "half_open"
    | "open"
    | "CLOSED"
    | "HALF_OPEN"
    | "OPEN"
    | "HALF-OPEN"
    | "half-open",
): void {
  const s = state.toLowerCase().replace("-", "_");
  const normState = (
    s === "half_open" ? "half_open" : s
  ) as "closed" | "half_open" | "open";

  providerCircuitBreakerTransitionsTotal.inc({
    provider,
    operation,
    state: normState,
  });

  const gaugeValue = CIRCUIT_BREAKER_STATE_VALUES[normState] ?? 0;
  providerCircuitBreakerState.set({ provider, operation }, gaugeValue);
}

export function setCircuitBreakerStateMetric(
  provider: string,
  operation: string,
  state:
    | "closed"
    | "half_open"
    | "open"
    | "CLOSED"
    | "HALF_OPEN"
    | "OPEN"
    | "HALF-OPEN"
    | "half-open",
): void {
  const s = state.toLowerCase().replace("-", "_");
  const normState = (
    s === "half_open" ? "half_open" : s
  ) as "closed" | "half_open" | "open";

  const gaugeValue = CIRCUIT_BREAKER_STATE_VALUES[normState] ?? 0;
  providerCircuitBreakerState.set({ provider, operation }, gaugeValue);
}

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

// AML and KYC Metrics
export const kycRequestsTotal = new Counter({
  name: "kyc_requests_total",
  help: "Total number of KYC and AML check requests",
  labelNames: ["provider", "status"],
  registers: [register],
});

// Database Connection Pool Health Metrics
export const dbPoolActiveConnections = new Gauge({
  name: "db_pool_active_connections",
  help: "Number of active connections checked out from the database pool",
  labelNames: ["pool"],
  registers: [register],
});

export const dbPoolIdleConnections = new Gauge({
  name: "db_pool_idle_connections",
  help: "Number of idle connections available in the database pool",
  labelNames: ["pool"],
  registers: [register],
});

export const dbPoolWaitingClients = new Gauge({
  name: "db_pool_waiting_clients",
  help: "Number of clients waiting for a database pool connection",
  labelNames: ["pool"],
  registers: [register],
});

export interface PoolMetricsSource {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}

export function emitPoolMetrics(
  poolInstance?: PoolMetricsSource | null,
  poolName = "primary",
): void {
  if (!poolInstance) return;
  const total = poolInstance.totalCount ?? 0;
  const idle = poolInstance.idleCount ?? 0;
  const waiting = poolInstance.waitingCount ?? 0;
  const active = Math.max(0, total - idle);

  dbPoolActiveConnections.labels(poolName).set(active);
  dbPoolIdleConnections.labels(poolName).set(idle);
  dbPoolWaitingClients.labels(poolName).set(waiting);
}
