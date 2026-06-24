# Analytics snapshot export

`export_analytics_snapshot(env)` is the read-only entrypoint intended for
off-chain dashboards and indexers. It returns a single versioned snapshot so a
consumer does not need to issue separate calls for platform and performance
metrics and risk torn reads across different ledger closes.

## Schema version contract

The current schema version is `1`, defined by `ANALYTICS_SCHEMA_VERSION` in
`src/analytics.rs`. Indexers should pin this value and treat any future change
as a migration signal. The value must be incremented when fields are removed,
renamed, reordered in a way that changes generated bindings, or their semantic
meaning changes incompatibly.

## JSON-equivalent shape

Soroban returns contract types rather than JSON directly. Indexers can map the
returned `AnalyticsSnapshot` to the following JSON-equivalent shape:

```json
{
  "schema_version": 1,
  "ledger_timestamp": 1717171717,
  "platform_metrics": {
    "total_invoices": 0,
    "total_funded": 0,
    "total_repaid": 0,
    "active_invoices": 0
  },
  "performance_metrics": {
    "repayment_rate_bps": 0,
    "default_rate_bps": 0,
    "average_duration_seconds": 0
  }
}
```

## Consistency and read-only behavior

The entrypoint performs no authorization checks and writes no storage. It
captures `ledger_timestamp` once, then composes
`AnalyticsCalculator::calculate_platform_metrics` and
`AnalyticsCalculator::calculate_performance_metrics` within the same host call.
Because Soroban contract execution observes one ledger close for a single call,
all snapshot fields correspond to that same close.

## Iteration bound

`ANALYTICS_SNAPSHOT_ITERATION_BOUND` documents the maximum number of records any
snapshot sub-calculator may scan in a single call: `1,000`. The current
implementation reads aggregate counters only and scans zero invoice or investor
records, so it remains safely under the host instruction budget. Future changes
that add record scanning must preserve this bound or introduce pagination rather
than expanding the snapshot call unboundedly.
