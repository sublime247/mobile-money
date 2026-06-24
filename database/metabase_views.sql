-- =============================================================================
-- Metabase BI Views — Mobile Money Anchor
-- =============================================================================
-- Purpose : Pre-built, analyst-friendly SQL views that flatten all JSONB
--           columns and pre-join common tables so Metabase dashboards need
--           zero raw JSON parsing and start up instantly.
--
-- Usage   : Run this file once against your database:
--               psql $DATABASE_URL -f database/metabase_views.sql
--           Re-run at any time to pick up schema changes (all CREATE OR REPLACE).
--
-- Schema  : All views live in the public schema under the "bi_" prefix to make
--           them easy to spot in the Metabase table browser.
--
-- Notes   : These are plain VIEWs so every Metabase query always sees live
--           data.  For large deployments see the MATERIALIZED VIEW section at
--           the bottom of this file.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. bi_transactions
--    One row per transaction; JSONB columns (metadata, location_metadata)
--    expanded into typed, named columns.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_transactions AS
SELECT
    t.id,
    t.reference_number,
    t.type,
    t.status,
    t.provider,
    t.amount,
    t.currency,
    t.original_amount,
    t.converted_amount,
    -- Stellar address is stored encrypted in the app; the raw column value
    -- is available here for correlation with Stellar Horizon data.
    t.stellar_address,

    -- Tags array exposed for Metabase "contains" filters
    t.tags,
    array_length(t.tags, 1)                        AS tag_count,

    -- Webhook reliability
    t.webhook_delivery_status,
    t.webhook_last_attempt_at,
    t.webhook_delivered_at,
    CASE
        WHEN t.webhook_delivered_at IS NOT NULL AND t.webhook_last_attempt_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (t.webhook_delivered_at - t.webhook_last_attempt_at))::INTEGER
    END                                             AS webhook_delivery_seconds,

    -- Location (from JSONB location_metadata)
    t.location_metadata->>'country'                AS geo_country,
    t.location_metadata->>'countryCode'            AS geo_country_code,
    t.location_metadata->>'city'                   AS geo_city,
    t.location_metadata->>'isp'                    AS geo_isp,
    t.location_metadata->>'status'                 AS geo_resolution_status,

    -- Common metadata keys surfaced as first-class columns
    -- (add more as your team standardises metadata keys)
    t.metadata->>'source'                          AS meta_source,
    t.metadata->>'campaign'                        AS meta_campaign,
    t.metadata->>'channel'                         AS meta_channel,
    t.metadata->>'reason'                          AS meta_reason,

    -- User info (de-normalised for convenience; phone_number is encrypted
    -- in the app layer so the DB column contains ciphertext)
    t.user_id,
    u.kyc_level,
    u.status                                       AS user_status,
    u.stellar_address                              AS user_stellar_address,

    -- Vault linkage
    t.vault_id,

    -- Time dimensions
    t.created_at,
    t.updated_at,
    DATE_TRUNC('day',   t.created_at)              AS day,
    DATE_TRUNC('week',  t.created_at)              AS week,
    DATE_TRUNC('month', t.created_at)              AS month,
    DATE_TRUNC('year',  t.created_at)              AS year,
    TO_CHAR(t.created_at, 'Dy')                    AS day_of_week,
    EXTRACT(HOUR FROM t.created_at)::INTEGER       AS hour_of_day

FROM transactions t
LEFT JOIN users u ON u.id = t.user_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. bi_daily_volume
--    Pre-aggregated daily transaction KPIs — the backbone of the executive
--    dashboard.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_daily_volume AS
SELECT
    DATE_TRUNC('day', created_at)                          AS report_date,
    COUNT(*)                                               AS total_transactions,
    COUNT(*) FILTER (WHERE type = 'deposit')               AS deposits,
    COUNT(*) FILTER (WHERE type = 'withdraw')              AS withdrawals,
    COUNT(*) FILTER (WHERE status = 'completed')           AS completed,
    COUNT(*) FILTER (WHERE status = 'failed')              AS failed,
    COUNT(*) FILTER (WHERE status = 'cancelled')           AS cancelled,
    COUNT(*) FILTER (WHERE status = 'pending')             AS pending,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'completed')
        / NULLIF(COUNT(*), 0), 2
    )                                                      AS success_rate_pct,

    -- Volume
    COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0)          AS completed_volume,
    COALESCE(SUM(amount) FILTER (WHERE type = 'deposit'
                                    AND status = 'completed'), 0)         AS deposit_volume,
    COALESCE(SUM(amount) FILTER (WHERE type = 'withdraw'
                                    AND status = 'completed'), 0)         AS withdrawal_volume,
    COALESCE(AVG(amount) FILTER (WHERE status = 'completed'), 0)          AS avg_transaction_amount,

    -- Unique active users
    COUNT(DISTINCT user_id) FILTER (WHERE status = 'completed')           AS unique_active_users,

    -- Webhook health
    COUNT(*) FILTER (WHERE webhook_delivery_status = 'delivered')         AS webhooks_delivered,
    COUNT(*) FILTER (WHERE webhook_delivery_status = 'failed')            AS webhooks_failed,

    currency
FROM transactions
GROUP BY DATE_TRUNC('day', created_at), currency
ORDER BY report_date DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. bi_provider_performance
--    Success rates, volumes, and failure breakdown by mobile money provider.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_provider_performance AS
SELECT
    provider,
    DATE_TRUNC('day', created_at)                          AS report_date,
    COUNT(*)                                               AS total_transactions,
    COUNT(*) FILTER (WHERE status = 'completed')           AS completed,
    COUNT(*) FILTER (WHERE status = 'failed')              AS failed,
    COUNT(*) FILTER (WHERE status = 'cancelled')           AS cancelled,
    COUNT(*) FILTER (WHERE status = 'pending')             AS pending,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'completed')
        / NULLIF(COUNT(*), 0), 2
    )                                                      AS success_rate_pct,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'failed')
        / NULLIF(COUNT(*), 0), 2
    )                                                      AS failure_rate_pct,
    COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0)  AS completed_volume,
    COALESCE(AVG(amount) FILTER (WHERE status = 'completed'), 0)  AS avg_amount,
    COALESCE(MAX(amount) FILTER (WHERE status = 'completed'), 0)  AS max_amount,
    currency
FROM transactions
GROUP BY provider, DATE_TRUNC('day', created_at), currency
ORDER BY report_date DESC, provider;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. bi_user_summary
--    One row per user; combines account info with activity metrics so analysts
--    can segment and slice without any joins.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_user_summary AS
SELECT
    u.id                                                   AS user_id,
    u.kyc_level,
    u.status                                               AS account_status,
    u.stellar_address,
    u.created_at                                           AS registered_at,
    DATE_TRUNC('month', u.created_at)                      AS registration_month,

    -- Session Security Metadata
    u.last_login_at,
    u.last_login_ip,
    u.last_login_user_agent,

    -- KYC verification
    ka.verification_status                                 AS kyc_verification_status,
    ka.provider                                            AS kyc_provider,
    ka.kyc_level                                           AS kyc_achieved_level,
    ka.updated_at                                          AS kyc_last_updated,

    -- Transaction activity
    COUNT(t.id)                                            AS lifetime_transactions,
    COUNT(t.id) FILTER (WHERE t.status = 'completed')     AS completed_transactions,
    COUNT(t.id) FILTER (WHERE t.type = 'deposit')         AS total_deposits,
    COUNT(t.id) FILTER (WHERE t.type = 'withdraw')        AS total_withdrawals,
    COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'completed'), 0) AS lifetime_volume,
    COALESCE(MAX(t.amount) FILTER (WHERE t.status = 'completed'), 0) AS largest_transaction,
    MAX(t.created_at) FILTER (WHERE t.status = 'completed')          AS last_active_at,

    -- Days since last activity (useful for churn analysis)
    EXTRACT(DAY FROM NOW() - MAX(t.created_at) FILTER (
        WHERE t.status = 'completed'
    ))::INTEGER                                            AS days_since_last_activity,

    -- Vault usage
    COUNT(DISTINCT v.id)                                   AS vault_count,
    COALESCE(SUM(v.balance), 0)                            AS total_vault_balance,

    -- Device fingerprint count (risk signal)
    COUNT(DISTINCT df.fingerprint)                         AS device_count,

    -- Referral info
    r.referral_code,
    r.referred_by,
    r.reward_granted                                       AS referral_reward_granted

FROM users u
LEFT JOIN kyc_applicants ka  ON ka.user_id = u.id
LEFT JOIN transactions t     ON t.user_id  = u.id
LEFT JOIN vaults v           ON v.user_id  = u.id AND v.is_active
LEFT JOIN device_fingerprints df ON df.user_id = u.id
LEFT JOIN referrals r        ON r.user_id  = u.id
GROUP BY
    u.id, u.kyc_level, u.status, u.stellar_address, u.created_at,
    u.last_login_at, u.last_login_ip, u.last_login_user_agent,
    ka.verification_status, ka.provider, ka.kyc_level, ka.updated_at,
    r.referral_code, r.referred_by, r.reward_granted;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. bi_kyc_funnel
--    KYC conversion funnel — how many users reach each verification level,
--    aggregated by registration cohort month.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_kyc_funnel AS
SELECT
    DATE_TRUNC('month', u.created_at)                      AS cohort_month,
    COUNT(DISTINCT u.id)                                   AS total_users,
    COUNT(DISTINCT u.id) FILTER (WHERE u.kyc_level = 'unverified') AS unverified,
    COUNT(DISTINCT u.id) FILTER (WHERE u.kyc_level = 'basic')      AS basic_kyc,
    COUNT(DISTINCT u.id) FILTER (WHERE u.kyc_level = 'full')       AS full_kyc,
    ROUND(
        100.0 * COUNT(DISTINCT u.id) FILTER (WHERE u.kyc_level IN ('basic', 'full'))
        / NULLIF(COUNT(DISTINCT u.id), 0), 2
    )                                                      AS any_kyc_rate_pct,
    ROUND(
        100.0 * COUNT(DISTINCT u.id) FILTER (WHERE u.kyc_level = 'full')
        / NULLIF(COUNT(DISTINCT u.id), 0), 2
    )                                                      AS full_kyc_rate_pct,

    -- KYC application outcomes
    COUNT(DISTINCT ka.user_id) FILTER (
        WHERE ka.verification_status = 'approved'
    )                                                      AS kyc_approved,
    COUNT(DISTINCT ka.user_id) FILTER (
        WHERE ka.verification_status = 'rejected'
    )                                                      AS kyc_rejected,
    COUNT(DISTINCT ka.user_id) FILTER (
        WHERE ka.verification_status = 'pending'
    )                                                      AS kyc_pending,
    COUNT(DISTINCT ka.user_id) FILTER (
        WHERE ka.verification_status = 'review'
    )                                                      AS kyc_in_review

FROM users u
LEFT JOIN kyc_applicants ka ON ka.user_id = u.id
GROUP BY DATE_TRUNC('month', u.created_at)
ORDER BY cohort_month DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. bi_dispute_overview
--    Dispute tracking with SLA, resolution times, and priority breakdown.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_dispute_overview AS
SELECT
    d.id                                                   AS dispute_id,
    d.status                                               AS dispute_status,
    d.priority,
    d.category,
    d.assigned_to,
    d.sla_due_date,
    d.sla_warning_sent,

    -- SLA breach flag
    CASE
        WHEN d.status NOT IN ('resolved', 'rejected', 'reversed', 'upheld')
         AND d.sla_due_date < NOW()
        THEN TRUE
        ELSE FALSE
    END                                                    AS sla_breached,

    -- Age and resolution time
    d.created_at                                           AS opened_at,
    d.updated_at                                           AS last_updated_at,
    EXTRACT(DAY FROM NOW() - d.created_at)::INTEGER        AS age_days,
    CASE
        WHEN d.status IN ('resolved', 'rejected', 'reversed', 'upheld')
        THEN EXTRACT(EPOCH FROM (d.updated_at - d.created_at)) / 3600.0
    END                                                    AS resolution_hours,

    -- Linked transaction details
    t.reference_number,
    t.type                                                 AS transaction_type,
    t.amount                                               AS transaction_amount,
    t.currency                                             AS transaction_currency,
    t.provider,
    t.status                                               AS transaction_status,
    t.user_id,
    u.kyc_level,

    -- Evidence and note counts
    (SELECT COUNT(*) FROM dispute_evidence de WHERE de.dispute_id = d.id) AS evidence_count,
    (SELECT COUNT(*) FROM dispute_notes   dn WHERE dn.dispute_id = d.id) AS note_count,

    -- Time dimensions
    DATE_TRUNC('day',   d.created_at)                      AS day,
    DATE_TRUNC('month', d.created_at)                      AS month

FROM disputes d
JOIN  transactions t ON t.id = d.transaction_id
LEFT JOIN users    u ON u.id = t.user_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. bi_vault_summary
--    Vault balances and activity — useful for savings product dashboards.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_vault_summary AS
SELECT
    v.id                                                   AS vault_id,
    v.user_id,
    v.name                                                 AS vault_name,
    v.balance                                              AS current_balance,
    v.target_amount,
    v.is_active,
    CASE
        WHEN v.target_amount > 0
        THEN ROUND(100.0 * v.balance / v.target_amount, 2)
    END                                                    AS target_progress_pct,

    -- Transaction history
    COUNT(vt.id)                                           AS total_vault_txns,
    COUNT(vt.id) FILTER (WHERE vt.type = 'deposit')        AS vault_deposits,
    COUNT(vt.id) FILTER (WHERE vt.type = 'withdraw')       AS vault_withdrawals,
    COALESCE(SUM(vt.amount) FILTER (WHERE vt.type = 'deposit'),  0) AS total_deposited,
    COALESCE(SUM(vt.amount) FILTER (WHERE vt.type = 'withdraw'), 0) AS total_withdrawn,
    MAX(vt.created_at)                                     AS last_activity_at,

    -- User KYC level for segmentation
    u.kyc_level,
    u.status                                               AS user_status,

    v.created_at,
    DATE_TRUNC('month', v.created_at)                      AS created_month

FROM vaults v
LEFT JOIN vault_transactions vt ON vt.vault_id = v.id
LEFT JOIN users u               ON u.id        = v.user_id
GROUP BY v.id, v.user_id, v.name, v.balance, v.target_amount, v.is_active,
         v.created_at, u.kyc_level, u.status;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. bi_webhook_reliability
--    Daily webhook delivery health — pairs with an alert when failure rate
--    spikes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_webhook_reliability AS
SELECT
    DATE_TRUNC('day', created_at)                          AS report_date,
    provider,
    COUNT(*)                                               AS total_webhooks,
    COUNT(*) FILTER (WHERE webhook_delivery_status = 'delivered') AS delivered,
    COUNT(*) FILTER (WHERE webhook_delivery_status = 'failed')    AS failed,
    COUNT(*) FILTER (WHERE webhook_delivery_status = 'pending')   AS pending,
    COUNT(*) FILTER (WHERE webhook_delivery_status = 'skipped')   AS skipped,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE webhook_delivery_status = 'delivered')
        / NULLIF(COUNT(*), 0), 2
    )                                                      AS delivery_rate_pct,

    -- Average delivery latency for successfully delivered webhooks
    ROUND(
        AVG(
            EXTRACT(EPOCH FROM (webhook_delivered_at - webhook_last_attempt_at))
        ) FILTER (WHERE webhook_delivery_status = 'delivered'), 2
    )                                                      AS avg_delivery_seconds

FROM transactions
WHERE webhook_delivery_status != 'skipped'
GROUP BY DATE_TRUNC('day', created_at), provider
ORDER BY report_date DESC, provider;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. bi_pnl_daily
--    Daily P&L with a 7-day and 30-day rolling average for trend lines.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_pnl_daily AS
SELECT
    s.report_date,
    s.user_fees,
    s.provider_fees,
    s.pnl,
    -- Cumulative totals (running sum ordered by date)
    SUM(s.pnl)          OVER (ORDER BY s.report_date)      AS cumulative_pnl,
    SUM(s.user_fees)    OVER (ORDER BY s.report_date)      AS cumulative_user_fees,
    SUM(s.provider_fees) OVER (ORDER BY s.report_date)     AS cumulative_provider_fees,
    -- Rolling 7-day average
    AVG(s.pnl)          OVER (
        ORDER BY s.report_date
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    )                                                      AS pnl_7day_avg,
    -- Rolling 30-day average
    AVG(s.pnl)          OVER (
        ORDER BY s.report_date
        ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    )                                                      AS pnl_30day_avg,
    -- Week-over-week change
    s.pnl - LAG(s.pnl, 7) OVER (ORDER BY s.report_date)   AS pnl_wow_change
FROM daily_pnl_snapshots s
ORDER BY s.report_date DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. bi_geo_distribution
--     Geographic spread of completed transactions (location_metadata JSONB
--     already flattened so Metabase needs no custom expressions).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_geo_distribution AS
SELECT
    location_metadata->>'country'       AS country,
    location_metadata->>'countryCode'   AS country_code,
    location_metadata->>'city'          AS city,
    location_metadata->>'isp'           AS isp,
    location_metadata->>'status'        AS geo_resolution_status,
    provider,
    type                                AS transaction_type,
    currency,
    DATE_TRUNC('month', created_at)     AS month,
    COUNT(*)                            AS transaction_count,
    SUM(amount)                         AS total_volume,
    AVG(amount)                         AS avg_amount
FROM transactions
WHERE status = 'completed'
  AND location_metadata IS NOT NULL
GROUP BY
    location_metadata->>'country',
    location_metadata->>'countryCode',
    location_metadata->>'city',
    location_metadata->>'isp',
    location_metadata->>'status',
    provider, type, currency, DATE_TRUNC('month', created_at)
ORDER BY month DESC, total_volume DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. bi_user_retention
--     Monthly cohort × activity month matrix for retention analysis.
--     Each row is a (cohort_month, activity_month) pair with user counts.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_user_retention AS
SELECT
    DATE_TRUNC('month', u.created_at)                      AS cohort_month,
    DATE_TRUNC('month', t.created_at)                      AS activity_month,
    -- Months since registration (0 = same month as sign-up)
    EXTRACT(
        MONTH FROM AGE(
            DATE_TRUNC('month', t.created_at),
            DATE_TRUNC('month', u.created_at)
        )
    ) + 12 * EXTRACT(
        YEAR FROM AGE(
            DATE_TRUNC('month', t.created_at),
            DATE_TRUNC('month', u.created_at)
        )
    )                                                      AS months_since_signup,
    COUNT(DISTINCT u.id)                                   AS active_users,
    COUNT(DISTINCT t.id)                                   AS transactions_in_period
FROM users u
JOIN transactions t
    ON  t.user_id  = u.id
    AND t.status   = 'completed'
    AND t.created_at >= u.created_at
GROUP BY
    DATE_TRUNC('month', u.created_at),
    DATE_TRUNC('month', t.created_at)
ORDER BY cohort_month DESC, activity_month;

-- =============================================================================
-- OPTIONAL: MATERIALIZED VIEWS for large datasets (>1 M rows)
-- =============================================================================
-- Uncomment the blocks below for any view whose underlying query becomes
-- noticeably slow.  After creating the materialized view, set up a pg_cron
-- job (or a cron-triggered DB function) to refresh it:
--
--   SELECT cron.schedule('refresh-bi-daily', '*/15 * * * *',
--     'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_bi_daily_volume');
--
-- Note: CONCURRENTLY requires a UNIQUE index on the view.
-- =============================================================================

/*
-- Materialized version of bi_daily_volume
DROP MATERIALIZED VIEW IF EXISTS mv_bi_daily_volume;
CREATE MATERIALIZED VIEW mv_bi_daily_volume AS
    SELECT * FROM bi_daily_volume;
CREATE UNIQUE INDEX ON mv_bi_daily_volume (report_date, currency);

-- Materialized version of bi_provider_performance
DROP MATERIALIZED VIEW IF EXISTS mv_bi_provider_performance;
CREATE MATERIALIZED VIEW mv_bi_provider_performance AS
    SELECT * FROM bi_provider_performance;
CREATE UNIQUE INDEX ON mv_bi_provider_performance (report_date, provider, currency);

-- Materialized version of bi_geo_distribution
DROP MATERIALIZED VIEW IF EXISTS mv_bi_geo_distribution;
CREATE MATERIALIZED VIEW mv_bi_geo_distribution AS
    SELECT * FROM bi_geo_distribution;
*/
