-- Migration: Travel Rule records for AML compliance
-- Stores encrypted sender/receiver identity data for transactions >= $1000
-- Per FATF Recommendation 16 ("Travel Rule")

CREATE TABLE IF NOT EXISTS travel_rule_records (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id          UUID        NOT NULL,
  amount                  DECIMAL(20, 7) NOT NULL,
  currency                VARCHAR(10) NOT NULL DEFAULT 'USD',

  -- Sender identity (AES-256-GCM encrypted)
  sender_name             TEXT        NOT NULL,
  sender_account          TEXT        NOT NULL,
  sender_address          TEXT,
  sender_dob              TEXT,
  sender_id_number        TEXT,

  -- Receiver identity (AES-256-GCM encrypted)
  receiver_name           TEXT        NOT NULL,
  receiver_account        TEXT        NOT NULL,
  receiver_address        TEXT,

  -- Originating / beneficiary institution
  originating_vasp        VARCHAR(100),
  beneficiary_vasp        VARCHAR(100),

  -- Audit
  created_at              TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  exported_at             TIMESTAMP,
  exported_by             VARCHAR(100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_rule_transaction
  ON travel_rule_records(transaction_id);

CREATE INDEX IF NOT EXISTS idx_travel_rule_created_at
  ON travel_rule_records(created_at);

CREATE INDEX IF NOT EXISTS idx_travel_rule_exported
  ON travel_rule_records(exported_at)
  WHERE exported_at IS NULL;
