# Remittance Funnel Observability & Metrics

## Overview

This document specifies the Prometheus metrics, Grafana dashboard panels, and alerting rules implemented for the end-to-end mobile money remittance funnel (Issue #2355).

## Funnel Stages

The remittance funnel tracks transactions through 5 chronological stages:

1. **`sep24_initiation`**: The client initiates an interactive deposit or withdrawal flow via SEP-24.
2. **`kyc_completion`**: The user successfully completes identity verification via SEP-12.
3. **`telco_dispatch`**: The mobile money anchor sends the payment/payout dispatch to the telecommunications partner (e.g., MTN, Orange, Airtel).
4. **`stellar_settlement`**: The transaction settlement is submitted and validated on the Stellar ledger.
5. **`confirmation`**: Final settlement confirmation is recorded and callbacks are dispatched to the customer/client.

## Prometheus Metrics

### 1. `remittance_funnel_stage_total`

- **Type**: Counter
- **Description**: Total count of transactions entering or completing a remittance stage.
- **Labels**:
  - `stage`: `sep24_initiation`, `kyc_completion`, `telco_dispatch`, `stellar_settlement`, `confirmation`
  - `status`: `success`, `failure`, `pending`
  - `provider`: Mobile money carrier/partner (e.g., `mtn`, `orange`, `airtel`)
  - `currency`: Fiat or token code (e.g., `XOF`, `XAF`, `USDC`)

### 2. `remittance_funnel_duration_seconds`

- **Type**: Histogram
- **Description**: Latency of transactions passing through funnel stages, enabling percentiles calculation (p50, p90, p95).
- **Buckets**: `[0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]` seconds.
- **Labels**:
  - `stage`
  - `provider`

### 3. `remittance_drop_off_total`

- **Type**: Counter
- **Description**: Total count of transactions dropped at a specific stage with categorized failure reasons.
- **Labels**:
  - `stage`
  - `reason`: (e.g., `kyc_rejected`, `telco_timeout`, `tx_bad_seq`, `insufficient_balance`)
  - `provider`

## Grafana Dashboard

The dashboard definition is located at [`monitoring/grafana/dashboards/remittance_funnel.json`](../monitoring/grafana/dashboards/remittance_funnel.json).

### Panels

- **Funnel Conversion Rate (E2E)**: Gauge measuring the conversion rate from `sep24_initiation` to `confirmation`.
- **Remittance Funnel Step Volume**: Time-series visualization of throughput across all 5 stages.
- **Stage Drop-Off Rates (%)**: Visualizes the drop-off percentage between consecutive steps.
- **Step Latency Percentiles (p50, p90, p95)**: Tracks step-level duration percentiles using histogram quantiles.
- **Provider Error Distribution**: Donut chart displaying the breakdown of failures per provider and failure reason.
- **Critical Alert Status**: Highlights any stage where drop-off exceeds 25% over a 15-minute window.

## Alerting Rule: >25% Funnel Drop-Off

- **Expression**:
  ```promql
  max(clamp_min((1 - (sum by (stage) (rate(remittance_funnel_stage_total{status="success"}[15m])) / sum by (stage) (rate(remittance_funnel_stage_total[15m])))) * 100, 0)) > 25
  ```
- **Duration**: `for: 15m`
- **Severity**: `critical`
- **Summary**: Funnel drop-off exceeded 25% threshold in the last 15 minutes.

## Automated Provisioning

Use [`monitoring/provision_dashboards.sh`](../monitoring/provision_dashboards.sh) to automatically validate JSON definitions and provision dashboards into a Grafana instance:

```bash
# Validate dashboard syntax locally
./monitoring/provision_dashboards.sh

# Or provision directly to Grafana API
GRAFANA_URL="https://grafana.example.com" GRAFANA_API_KEY="ey..." ./monitoring/provision_dashboards.sh
```
