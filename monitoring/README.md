# Provider float runway

Import `dashboards/float-runway.json` in Grafana and select the Prometheus
data source. Add `prometheus-rules.yml` to the Prometheus `rule_files` list and
reload Prometheus. Route `MobileMoneyProviderFloatDepletion` through the
deployment's Alertmanager configuration.

The template expects these series from the deployment's provider float exporter:

| Metric                                     | Type    | Meaning                               |
| ------------------------------------------ | ------- | ------------------------------------- |
| `mobile_money_provider_float_balance`      | Gauge   | Current available provider float      |
| `mobile_money_provider_float_debits_total` | Counter | Cumulative amounts debited from float |

Both metrics must use the same denomination and the labels `provider` and
`currency`. Use `mtn`, `orange`, `airtel`, or `mpesa` for the provider label.
Expose one authoritative balance series per provider and currency. Debit
counters may be split across workers and must count each debit once.

Runway divides current float by the trailing one-hour average debit rate
expressed per hour. Positive balances with zero or missing debit rates have
no estimate. An empty balance shows zero runway and triggers the alert even
without a debit rate. The alert also fires below 24 projected hours.
