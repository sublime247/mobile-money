-- Migration: Create SEP-38 Quotes Table
-- Created at: 2026-09-27
--
-- Stores firm quotes issued by the SEP-38 /quote endpoint.
-- Each row tracks the owning user, the locked price, the reserved liquidity
-- amount, and the lifecycle status so quotes can be cancelled explicitly or
-- swept by the expiry job.

CREATE TABLE sep38_quotes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        TEXT NOT NULL,                  -- JWT userId of the requesting client
    sell_asset      TEXT NOT NULL,                  -- SEP-38 asset identifier (sell side)
    buy_asset       TEXT NOT NULL,                  -- SEP-38 asset identifier (buy side)
    price           NUMERIC(24, 7) NOT NULL,        -- locked buy_asset units per 1 sell_asset
    fee_percent     NUMERIC(8, 4) NOT NULL,
    fee_fixed       NUMERIC(24, 7) NOT NULL DEFAULT 0,
    reserved_amount NUMERIC(24, 7) NOT NULL DEFAULT 0, -- sell_asset units reserved in the pool
    status          VARCHAR(16) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'cancelled', 'expired')),
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Lookup by owner for ownership verification
CREATE INDEX idx_sep38_quotes_owner ON sep38_quotes (owner_id);

-- Sweep job: find quotes that have passed their expiry
CREATE INDEX idx_sep38_quotes_status_expires ON sep38_quotes (status, expires_at)
    WHERE status = 'active';

-- Trigger to keep updated_at current
CREATE OR REPLACE FUNCTION update_sep38_quotes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sep38_quotes_updated_at
    BEFORE UPDATE ON sep38_quotes
    FOR EACH ROW
    EXECUTE FUNCTION update_sep38_quotes_updated_at();
