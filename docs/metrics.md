# Metrics Documentation

The following Prometheus metrics are exported by the application at `/metrics`.

## HTTP Metrics

- `http_requests_total`: Total number of HTTP requests.
  - Labels: `method`, `route`, `status_code`
- `http_request_duration_seconds`: Histogram of HTTP request durations.
  - Labels: `method`, `route`, `status_code`
  - Buckets: `0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10`
- `active_connections`: Gauge representing the current number of active HTTP connections.

## Business Logic Metrics

- `transaction_total`: Total number of transactions processed.
  - Labels: `type` (payment, payout, stellar_payment), `provider` (mtn, airtel, orange, stellar), `status` (success, failure)
- `transaction_errors_total`: Total number of transaction errors.
  - Labels: `type`, `provider`, `error_type` (provider_error, exception, stellar_error)

## Default Metrics

Standard Node.js metrics (CPU, Memory, Event Loop, etc.) are also exported via `prom-client`'s `collectDefaultMetrics`.

# Transaction and Dispute Resolution Time Metrics

## Overview

The metrics service tracks and exposes the 95th and 99th percentile resolution times for transactions and disputes. All metrics are calculated with millisecond precision and cached in Redis for performance.

## Features

- **Percentile Calculations**: P95, P99, median, mean, min, and max resolution times
- **SLA Breach Tracking**: Tracks breaches against 24-hour SLA threshold
- **Visual Status Indicators**: Green/Yellow/Red status based on breach percentage
- **Trend Analysis**: Daily resolution time trends over configurable periods
- **Redis Caching**: 5-minute TTL on percentile calculations to reduce database load
- **Read Replica Routing**: Metrics queries use `queryRead()` to leverage read replicas

## Database Queries

The service uses PostgreSQL's `PERCENTILE_CONT()` window function to calculate accurate percentiles:

```sql
PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY resolution_time_ms)
PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY resolution_time_ms)
```

Resolution time is calculated as:

```sql
EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000  -- milliseconds
```

## API Endpoints

### Transaction Resolution Metrics

```
GET /api/admin/metrics/transactions/resolution?days=30
```

**Response:**

```json
{
  "metrics": {
    "p95_ms": 18432000,
    "p99_ms": 22320000,
    "median_ms": 8640000,
    "mean_ms": 10800000,
    "min_ms": 60000,
    "max_ms": 86400000,
    "total_count": 1542,
    "sla_breaches_count": 147,
    "sla_breach_percentage": 9.5,
    "status": "yellow"
  },
  "trends": [
    {
      "date": "2026-03-21",
      "p95_ms": 18432000,
      "p99_ms": 22320000,
      "breach_count": 12,
      "total_count": 85
    }
  ],
  "period": "30 days",
  "sla_threshold_ms": 86400000,
  "sla_threshold_hours": 24
}
```

### Dispute Resolution Metrics

```
GET /api/admin/metrics/disputes/resolution?days=30
```

Same response structure as transactions.

## Status Indicators

- **Green**: 0% SLA breach rate - all operations within SLA
- **Yellow**: < 5% breach rate - acceptable, but monitor closely
- **Red**: ≥ 5% breach rate - critical attention needed

## Caching

All percentile calculations are cached in Redis with a 5-minute TTL:

- `metrics:transactions:percentiles`
- `metrics:disputes:percentiles`
- `metrics:transactions:trend`
- `metrics:disputes:trend`

To invalidate cache (e.g., after data corrections):

```typescript
import { invalidateMetricsCache } from "../services/metrics";
await invalidateMetricsCache();
```

## Millisecond Precision

All timestamps and calculations maintain millisecond precision:

- Database: `EXTRACT(EPOCH FROM ...) * 1000`
- Redis: `Date.now()` for real-time tracking
- API Response: Integer milliseconds (no floating point)

## Integration with Read Replicas

The metrics service leverages the read replica system for heavy report queries:

- Uses `queryRead()` instead of `pool.query()` for all SELECT queries
- Automatically routes to replica pool with fallback to primary
- Reduces load on primary database for analytics

## Performance Considerations

- **Cache TTL**: 5 minutes (configurable via `CACHE_TTL_SECONDS`)
- **SLA Threshold**: 24 hours (configurable via `SLA_THRESHOLD_MS`)
- **Query Optimization**: Uses PostgreSQL window functions instead of application-level calculations
- **Replica Failover**: Automatic fallback to primary if replica unavailable

## Adding New Metrics

To add new metrics calculations:

1. Create new function in `src/services/metrics.ts`
2. Use `queryRead()` for SELECT queries
3. Implement Redis caching with appropriate key prefix
4. Add endpoint to `src/routes/admin.ts`
5. Follow existing pattern for error handling and response format
