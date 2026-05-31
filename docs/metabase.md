# Metabase BI Configuration Guide

Pre-built SQL views that give Metabase instant access to clean, analyst-ready data — no raw JSON parsing, no ad-hoc joins, no slow start-up.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [View Reference](#view-reference)
   - [bi_transactions](#bi_transactions)
   - [bi_daily_volume](#bi_daily_volume)
   - [bi_provider_performance](#bi_provider_performance)
   - [bi_user_summary](#bi_user_summary)
   - [bi_kyc_funnel](#bi_kyc_funnel)
   - [bi_dispute_overview](#bi_dispute_overview)
   - [bi_vault_summary](#bi_vault_summary)
   - [bi_webhook_reliability](#bi_webhook_reliability)
   - [bi_pnl_daily](#bi_pnl_daily)
   - [bi_geo_distribution](#bi_geo_distribution)
   - [bi_user_retention](#bi_user_retention)
4. [Connecting Metabase](#connecting-metabase)
5. [Syncing the Schema](#syncing-the-schema)
6. [Suggested Dashboards](#suggested-dashboards)
7. [Performance: Materialized Views](#performance-materialized-views)
8. [Security Notes](#security-notes)

---

## Overview

The raw database schema uses:

| Pattern                                           | Problem for Metabase                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `transactions.metadata` (JSONB)                   | Requires `->` operators; Metabase's GUI cannot filter JSONB natively |
| `transactions.location_metadata` (JSONB)          | Country/city buried inside JSON                                      |
| `kyc_applicants.applicant_data` (JSONB)           | KYC fields inaccessible without custom SQL                           |
| Multi-table joins (users + transactions + vaults) | Analysts re-write the same join every question                       |

The views in `database/metabase_views.sql` solve all of this by:

- **Flattening every JSONB column** into typed, named columns (e.g. `geo_country`, `meta_campaign`)
- **Pre-joining** the tables analysts always combine
- **Pre-computing** derived columns (success rates, SLA breach flags, rolling averages, retention months)
- Using **plain VIEWs** (not materialized) so every dashboard query always reflects live data

---

## Quick Start

### 1. Apply the views

```bash
psql "$DATABASE_URL" -f database/metabase_views.sql
```

Re-run at any time — all statements use `CREATE OR REPLACE VIEW` so it is safe to run repeatedly.

### 2. Verify

```sql
-- Quick sanity check
SELECT * FROM bi_daily_volume LIMIT 5;
SELECT * FROM bi_transactions LIMIT 5;
```

### 3. Connect Metabase (see [Connecting Metabase](#connecting-metabase))

### 4. Sync the schema and start building questions

---

## View Reference

### bi_transactions

**Purpose:** One row per transaction with all JSONB columns expanded and user info joined. Use this as the base for any ad-hoc transaction analysis.

**Key columns:**

| Column                            | Type      | Description                                   |
| --------------------------------- | --------- | --------------------------------------------- |
| `id`                              | UUID      | Transaction primary key                       |
| `reference_number`                | VARCHAR   | Human-readable reference                      |
| `type`                            | VARCHAR   | `deposit` or `withdraw`                       |
| `status`                          | VARCHAR   | `pending`, `completed`, `failed`, `cancelled` |
| `provider`                        | VARCHAR   | Mobile money provider (MTN, Airtel, Orange…)  |
| `amount`                          | DECIMAL   | Transaction amount                            |
| `currency`                        | VARCHAR   | ISO 4217 currency code                        |
| `tags`                            | TEXT[]    | Array of tag strings                          |
| `tag_count`                       | INTEGER   | Number of tags (handy filter)                 |
| `geo_country`                     | TEXT      | Country from location_metadata                |
| `geo_country_code`                | TEXT      | ISO country code                              |
| `geo_city`                        | TEXT      | City from location_metadata                   |
| `geo_isp`                         | TEXT      | ISP from location_metadata                    |
| `geo_resolution_status`           | TEXT      | `resolved`, `unknown`, or `pending`           |
| `meta_source`                     | TEXT      | `metadata->>'source'`                         |
| `meta_campaign`                   | TEXT      | `metadata->>'campaign'`                       |
| `meta_channel`                    | TEXT      | `metadata->>'channel'`                        |
| `meta_reason`                     | TEXT      | `metadata->>'reason'`                         |
| `kyc_level`                       | VARCHAR   | User's KYC level at time of query             |
| `webhook_delivery_seconds`        | INTEGER   | Seconds from attempt to delivery              |
| `day` / `week` / `month` / `year` | TIMESTAMP | Truncated time buckets                        |
| `day_of_week`                     | TEXT      | `Mon`, `Tue`, …                               |
| `hour_of_day`                     | INTEGER   | 0–23                                          |

**Example Metabase question:** _"Completed deposit volume by country this month"_

- Table: `bi_transactions`
- Filter: `type = deposit`, `status = completed`, `month = [this month]`
- Group by: `geo_country`
- Summarize: `sum of amount`

---

### bi_daily_volume

**Purpose:** Pre-aggregated daily transaction KPIs. Use this for time-series charts and executive dashboards.

| Column                                           | Description                                |
| ------------------------------------------------ | ------------------------------------------ |
| `report_date`                                    | Day (truncated)                            |
| `currency`                                       | Currency bucket                            |
| `total_transactions`                             | All transactions that day                  |
| `deposits` / `withdrawals`                       | By type                                    |
| `completed` / `failed` / `cancelled` / `pending` | By status                                  |
| `success_rate_pct`                               | `completed / total × 100`                  |
| `completed_volume`                               | Sum of completed amounts                   |
| `deposit_volume` / `withdrawal_volume`           | Split volumes                              |
| `avg_transaction_amount`                         | Average completed transaction              |
| `unique_active_users`                            | Distinct users with completed transactions |
| `webhooks_delivered` / `webhooks_failed`         | Webhook health                             |

**Example Metabase question:** _"Daily success rate trend (last 30 days)"_

- Table: `bi_daily_volume`
- Filter: `report_date > [30 days ago]`
- X-axis: `report_date`
- Y-axis: `success_rate_pct`

---

### bi_provider_performance

**Purpose:** Success rates, volumes, and failure rates broken down by provider × day. Build a provider health heatmap or failure alert.

| Column                      | Description                  |
| --------------------------- | ---------------------------- |
| `provider`                  | Mobile money provider        |
| `report_date`               | Day                          |
| `success_rate_pct`          | Provider success rate        |
| `failure_rate_pct`          | Provider failure rate        |
| `completed_volume`          | Completed transaction volume |
| `avg_amount` / `max_amount` | Amount stats                 |

**Example Metabase question:** _"Provider failure rate this week"_

- Table: `bi_provider_performance`
- Filter: `report_date >= [start of week]`
- Group by: `provider`
- Summarize: `avg of failure_rate_pct`

---

### bi_user_summary

**Purpose:** One row per user with lifetime activity metrics pre-joined. Segment users, build cohort charts, or find churned accounts.

| Column                     | Description                              |
| -------------------------- | ---------------------------------------- |
| `user_id`                  | User UUID                                |
| `kyc_level`                | `unverified`, `basic`, `full`            |
| `account_status`           | `active`, `frozen`, `suspended`          |
| `registered_at`            | Registration timestamp                   |
| `registration_month`       | Month bucket for cohort analysis         |
| `kyc_verification_status`  | KYC provider outcome                     |
| `kyc_achieved_level`       | Achieved verification level              |
| `lifetime_transactions`    | Total ever                               |
| `completed_transactions`   | Successful only                          |
| `lifetime_volume`          | Sum of completed amounts                 |
| `largest_transaction`      | Max single transaction                   |
| `last_active_at`           | Last completed transaction timestamp     |
| `days_since_last_activity` | For churn/dormancy analysis              |
| `vault_count`              | Number of active vaults                  |
| `total_vault_balance`      | Sum of vault balances                    |
| `device_count`             | Unique device fingerprints (risk signal) |
| `referral_code`            | User's referral code                     |
| `referral_reward_granted`  | Whether referral reward was issued       |

**Example Metabase question:** _"Active vs dormant users by KYC level"_

- Table: `bi_user_summary`
- Group by: `kyc_level`
- Summarize: `count of user_id` (filter `days_since_last_activity <= 30` for active)

---

### bi_kyc_funnel

**Purpose:** Month-by-month KYC conversion funnel. See how many users from each registration cohort reached basic vs full verification.

| Column                                                            | Description                |
| ----------------------------------------------------------------- | -------------------------- |
| `cohort_month`                                                    | Month users registered     |
| `total_users`                                                     | Total registered in cohort |
| `unverified` / `basic_kyc` / `full_kyc`                           | Users at each level        |
| `any_kyc_rate_pct`                                                | % with any verification    |
| `full_kyc_rate_pct`                                               | % with full verification   |
| `kyc_approved` / `kyc_rejected` / `kyc_pending` / `kyc_in_review` | Application outcomes       |

**Example Metabase question:** _"KYC funnel by registration cohort"_

- Table: `bi_kyc_funnel`
- X-axis: `cohort_month`
- Y-axis (multi-series): `unverified`, `basic_kyc`, `full_kyc`
- Chart type: Stacked bar

---

### bi_dispute_overview

**Purpose:** Dispute tracking with SLA status, priority breakdown, and resolution time. Use this for the compliance/ops team dashboard.

| Column               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `dispute_id`         | Dispute UUID                                    |
| `dispute_status`     | `open`, `investigating`, `resolved`, `rejected` |
| `priority`           | `low`, `medium`, `high`, `critical`             |
| `category`           | Dispute category                                |
| `sla_breached`       | `true` if open past SLA due date                |
| `age_days`           | Days since opened                               |
| `resolution_hours`   | Hours to resolve (null if still open)           |
| `transaction_amount` | Disputed transaction amount                     |
| `evidence_count`     | Files attached                                  |
| `note_count`         | Internal notes written                          |

**Example Metabase question:** _"Open disputes by priority with SLA breach flag"_

- Table: `bi_dispute_overview`
- Filter: `dispute_status = open`
- Group by: `priority`, `sla_breached`
- Summarize: `count of dispute_id`

---

### bi_vault_summary

**Purpose:** Vault (savings) product metrics — balances, deposits, withdrawals, progress toward target amounts.

| Column                                | Description            |
| ------------------------------------- | ---------------------- |
| `vault_id`                            | Vault UUID             |
| `vault_name`                          | User-defined name      |
| `current_balance`                     | Current vault balance  |
| `target_amount`                       | Savings goal           |
| `target_progress_pct`                 | % of goal reached      |
| `total_deposited` / `total_withdrawn` | Lifetime flows         |
| `last_activity_at`                    | Last vault transaction |
| `kyc_level`                           | Owner's KYC level      |

---

### bi_webhook_reliability

**Purpose:** Daily webhook delivery health per provider. Set a Metabase alert when `delivery_rate_pct` drops below threshold.

| Column                             | Description                            |
| ---------------------------------- | -------------------------------------- |
| `report_date`                      | Day                                    |
| `provider`                         | Provider name                          |
| `delivery_rate_pct`                | Delivered / total × 100                |
| `avg_delivery_seconds`             | Average latency for delivered webhooks |
| `delivered` / `failed` / `pending` | Counts by status                       |

**Metabase Alert:** Set an alert on a `bi_webhook_reliability` question to notify via Slack/email when `delivery_rate_pct < 95`.

---

### bi_pnl_daily

**Purpose:** Daily P&L report with cumulative totals and rolling averages. Powered by the `daily_pnl_snapshots` table.

| Column           | Description                                   |
| ---------------- | --------------------------------------------- |
| `report_date`    | Day                                           |
| `user_fees`      | Fees collected from users                     |
| `provider_fees`  | Fees paid to providers                        |
| `pnl`            | Net profit/loss (`user_fees - provider_fees`) |
| `cumulative_pnl` | Running total P&L                             |
| `pnl_7day_avg`   | 7-day rolling average                         |
| `pnl_30day_avg`  | 30-day rolling average                        |
| `pnl_wow_change` | P&L vs same day last week                     |

**Example Metabase question:** _"P&L trend with 7-day smoothing"_

- Table: `bi_pnl_daily`
- X-axis: `report_date`
- Y-axis (multi-series): `pnl`, `pnl_7day_avg`

---

### bi_geo_distribution

**Purpose:** Geographic breakdown of completed transactions. Every `location_metadata` JSONB key is a named column — no custom SQL expressions needed in Metabase.

| Column                        | Description                      |
| ----------------------------- | -------------------------------- |
| `country` / `country_code`    | Resolved country                 |
| `city`                        | Resolved city                    |
| `isp`                         | Internet service provider        |
| `geo_resolution_status`       | `resolved`, `unknown`, `pending` |
| `transaction_count`           | Number of completed transactions |
| `total_volume` / `avg_amount` | Volume metrics                   |

**Metabase Map chart:** Use `country_code` as the region column to render a world map automatically.

---

### bi_user_retention

**Purpose:** Monthly cohort retention matrix. Each row is a (registration cohort × activity month) pair — paste this into a pivot table for a classic retention grid.

| Column                   | Description                         |
| ------------------------ | ----------------------------------- |
| `cohort_month`           | Month users registered              |
| `activity_month`         | Month users were active             |
| `months_since_signup`    | 0 = same month as registration      |
| `active_users`           | Users with ≥1 completed transaction |
| `transactions_in_period` | Transaction count that period       |

**Metabase Pivot Table:** Row = `cohort_month`, Column = `months_since_signup`, Value = `active_users`.

---

## Connecting Metabase

### Option A — Metabase Cloud / Self-hosted UI

1. Go to **Admin → Databases → Add Database**
2. Select **PostgreSQL**
3. Fill in your database credentials (use a read-only role — see [Security Notes](#security-notes))
4. Toggle **"Let users upload data to this database"** → OFF
5. Click **Save**

### Option B — `MB_DB_*` environment variables (self-hosted Docker)

```env
MB_DB_TYPE=postgres
MB_DB_HOST=your-db-host
MB_DB_PORT=5432
MB_DB_DBNAME=your-db-name
MB_DB_USER=metabase_readonly
MB_DB_PASS=your-password
```

---

## Syncing the Schema

After applying the views, tell Metabase to pick them up:

1. **Admin → Databases → [your database] → Sync database schema now**
2. **Admin → Databases → [your database] → Re-scan field values** (populates filter dropdowns)

The `bi_*` views will appear in the Table Browser alongside the raw tables. You can hide raw tables from non-technical users:

**Admin → Data Model → [raw table] → toggle "Hidden"**

Leave only the `bi_*` views visible for self-service analysts.

---

## Suggested Dashboards

### Executive Overview

| Card                          | View                      | Chart type |
| ----------------------------- | ------------------------- | ---------- |
| Total completed volume (MTD)  | `bi_daily_volume`         | Big number |
| Daily transaction count (30d) | `bi_daily_volume`         | Line chart |
| Success rate trend            | `bi_daily_volume`         | Line chart |
| Volume by provider            | `bi_provider_performance` | Bar chart  |
| Daily P&L with 7-day average  | `bi_pnl_daily`            | Line chart |

### Operations Dashboard

| Card                               | View                     | Chart type                             |
| ---------------------------------- | ------------------------ | -------------------------------------- |
| Open disputes by priority          | `bi_dispute_overview`    | Bar chart                              |
| SLA-breached disputes              | `bi_dispute_overview`    | Table (filtered `sla_breached = true`) |
| Webhook delivery rate per provider | `bi_webhook_reliability` | Table                                  |
| Pending transactions count         | `bi_daily_volume`        | Big number                             |

### Growth & KYC Dashboard

| Card                      | View                  | Chart type                          |
| ------------------------- | --------------------- | ----------------------------------- |
| KYC funnel by cohort      | `bi_kyc_funnel`       | Stacked bar                         |
| User retention grid       | `bi_user_retention`   | Pivot table                         |
| New users by month        | `bi_user_summary`     | Bar (group by `registration_month`) |
| Transactions by geography | `bi_geo_distribution` | Map chart                           |

### Compliance Dashboard

| Card                                 | View                  | Chart type     |
| ------------------------------------ | --------------------- | -------------- |
| Users by account status              | `bi_user_summary`     | Pie chart      |
| High-device-count users (>3 devices) | `bi_user_summary`     | Table          |
| Dispute resolution time by category  | `bi_dispute_overview` | Box plot / bar |

---

## Performance: Materialized Views

Plain views always reflect live data but re-run the full query on every page load. For databases with more than ~1 million transactions, create materialized versions for the heavy aggregation views:

```sql
-- Example: materialize the daily volume view
CREATE MATERIALIZED VIEW mv_bi_daily_volume AS
    SELECT * FROM bi_daily_volume;

-- Required for REFRESH CONCURRENTLY (no table lock)
CREATE UNIQUE INDEX ON mv_bi_daily_volume (report_date, currency);
```

Schedule a refresh so the materialized view stays fresh:

```sql
-- Using pg_cron (install once per database)
SELECT cron.schedule(
    'refresh-bi-daily-volume',
    '*/15 * * * *',    -- every 15 minutes
    'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_bi_daily_volume'
);
```

Uncomment the materialized view blocks at the bottom of `database/metabase_views.sql` to apply them all at once.

> **Tip:** Keep `bi_transactions` as a plain VIEW. Analysts filter it down to a time window so the full table is rarely scanned.

---

## Security Notes

### Create a read-only Metabase role

Grant access only to the `bi_*` views, not the raw tables:

```sql
-- Create a dedicated read-only user for Metabase
CREATE ROLE metabase_readonly LOGIN PASSWORD 'strong-password';

-- Grant connect and usage
GRANT CONNECT ON DATABASE your_database TO metabase_readonly;
GRANT USAGE   ON SCHEMA public          TO metabase_readonly;

-- Grant SELECT on all bi_ views (run once; repeat after adding new views)
GRANT SELECT ON bi_transactions        TO metabase_readonly;
GRANT SELECT ON bi_daily_volume        TO metabase_readonly;
GRANT SELECT ON bi_provider_performance TO metabase_readonly;
GRANT SELECT ON bi_user_summary        TO metabase_readonly;
GRANT SELECT ON bi_kyc_funnel          TO metabase_readonly;
GRANT SELECT ON bi_dispute_overview    TO metabase_readonly;
GRANT SELECT ON bi_vault_summary       TO metabase_readonly;
GRANT SELECT ON bi_webhook_reliability TO metabase_readonly;
GRANT SELECT ON bi_pnl_daily           TO metabase_readonly;
GRANT SELECT ON bi_geo_distribution    TO metabase_readonly;
GRANT SELECT ON bi_user_retention      TO metabase_readonly;

-- Or grant on all current and future views in the schema:
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO metabase_readonly;
```

### PII considerations

- `phone_number` and `email` are **encrypted** at the application layer. The raw columns in `bi_transactions` and `bi_user_summary` contain ciphertext — they are safe to expose in Metabase but will not be human-readable.
- `stellar_address` is plaintext in the database. If your compliance policy requires it, exclude it by creating a custom view without that column.
- `notes`, `admin_notes`, and `reason` fields on transactions and disputes are also encrypted by the application layer.

### Row-level security (optional)

If you need to restrict Metabase users to specific providers or regions, add a PostgreSQL row-level security policy:

```sql
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Example: restrict to a specific provider
CREATE POLICY metabase_provider_filter ON transactions
    FOR SELECT TO metabase_readonly
    USING (provider = current_setting('app.provider', true));
```
