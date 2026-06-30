# Centralized Logging Architecture

This document outlines the logging architecture and provides the necessary LogQL queries for Grafana.

## LogQL Queries for Grafana

### 1. Error Rate %

This query calculates the percentage of logs with `level="ERROR"` relative to total logs.

```logql
sum(rate({container="mobilemoney_app"} | json | level="ERROR" [5m]))
/
sum(rate({container="mobilemoney_app"} [5m]))
* 100
```

### 2. P99 Response Latency

This query calculates the 99th percentile of response latency.
_Note: Requires logging `duration` or `responseTime` in the JSON payload._

```logql
quantile_over_time(0.99, {container="mobilemoney_app"} | json | unwrap duration [5m])
```

### 3. Security Events

Monitor custom "SECURITY" level logs.

```logql
{container="mobilemoney_app"} | json | level="SECURITY"
```

### 4. Audit Trail

Monitor custom "AUDIT" level logs.

```logql
{container="mobilemoney_app"} | json | level="AUDIT"
```

## Setup Instructions

1. **Start the Stack**:

   ```bash
   docker-compose up -d
   ```

2. **Access Grafana**:
   - URL: `http://localhost:3001`
   - User: `admin` / `admin`

3. **Configure Data Source**:
   - Add **Loki** as a data source.
   - URL: `http://loki:3100`

4. **Verify CI/CD Integrity**:
   ```bash
   bash scripts/verify-logging.sh
   ```
