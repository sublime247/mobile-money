# Monitoring: Grafana dashboard

`monitoring/grafana-dashboard.json` is a ready-to-import Grafana dashboard for payment
success monitoring. It is built entirely on metrics already exported by this
service (see `src/utils/metrics.ts`) via `prom-client` at `/metrics` - no new
instrumentation is required to use it.

## Importing

1. In Grafana: **Dashboards -> New -> Import**.
2. Upload `monitoring/grafana-dashboard.json`, or paste its contents.
3. When prompted, select your Prometheus data source for the `DS_PROMETHEUS`
   input. The dashboard's `datasource` template variable defaults to it.
4. The `provider` template variable is populated from
   `label_values(transactions_total, provider)` and defaults to "All".

## Panels

| Row | Panel | Query basis |
| --- | --- | --- |
| Payment success | Payment success rate (5m) | `transactions_total{status="success"}` / `transactions_total` |
| Payment success | Payment success rate by provider | same ratio, grouped by `provider` |
| Deposits, withdrawals & volume | Active deposits (fiat -> crypto) | `active_transactions{provider}` (in-flight gauge) |
| Deposits, withdrawals & volume | Withdrawals in the last hour | `increase(transaction_total{type="payout"}[1h])` |
| Deposits, withdrawals & volume | 24h transaction volume by currency | `increase(transactions_total[24h])` by `currency` |
| Deposits, withdrawals & volume | Deposits vs withdrawals over time | `rate(transaction_total[5m])` by `type` (`payment` = deposit-side, `payout` = withdrawal-side) |
| Provider latency | Provider response time p50/p95/p99 | `histogram_quantile(..., provider_response_time_seconds_bucket)` |
| Errors & provider failures | Transaction errors by error code | `rate(transaction_errors_total[5m])` by `provider, error_type` |
| Errors & provider failures | Provider failovers | `rate(provider_failover_total[5m])` by `from_provider, to_provider, reason` |
| Errors & provider failures | Provider circuit breaker state | `provider_circuit_breaker_state` (0=closed, 0.5=half-open, 1=open) |

## Threshold alert markers

The dashboard's built-in annotation query (**Provider failure spikes**) draws a
marker on every panel whenever `provider_circuit_breaker_state` changes for
any provider/operation in the last 5 minutes
(`changes(provider_circuit_breaker_state[5m]) > 0`), so a spike in provider
failures is visible directly on the timeline without needing a separate
alerting rule to correlate it against.

This is a dashboard-level marker, not a paging alert. For an actual Slack/Discord
notification when failures spike, see the alert dispatcher added alongside this
dashboard (`src/services/alertService.ts`).

## Label reference

All panels filter by the `$provider` template variable, using the exact label
name each underlying metric declares (see `src/utils/metrics.ts` for the full
list of metrics and labels):

- `provider` - one of the configured mobile money providers (MTN, Airtel, Orange, etc.)
- `status` - `"success"` / `"failed"` / etc., set at the transaction's completion
- `type` (on `transaction_total` / `transaction_errors_total` / `provider_failover_total`) -
  `"payment"` (deposit, fiat -> crypto) or `"payout"` (withdrawal, crypto -> fiat)
- `currency` - the fiat currency code of the transaction
- `operation` - the specific provider API operation (e.g. `"requestPayment"`, `"getBalance"`)
- `error_type` - the classified error code/category for a failed transaction

## Verifying locally

No live Prometheus/Grafana stack was available in the environment this dashboard
was authored in, so it was validated structurally instead of by a live import:

- The JSON was checked for valid syntax and required Grafana dashboard model
  keys (`title`, `panels`, `schemaVersion`, `templating`, `time`), unique panel
  `id`s, and a well-formed `templating`/`annotations` block.
- Every metric name and label referenced in every panel's PromQL expression
  was cross-checked, one by one, against the actual `name`/`labelNames`
  declared for that metric in `src/utils/metrics.ts` - all matched exactly.

Before relying on this in production, import it into a real Grafana instance
pointed at this service's live `/metrics` endpoint and confirm the panels
render with real data.
