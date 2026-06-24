-- Merchants table for merchant onboarding
CREATE TABLE IF NOT EXISTS merchants (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  email           VARCHAR(255) NOT NULL UNIQUE,
  phone_number    VARCHAR(20) NOT NULL,
  business_name   VARCHAR(255),
  business_type   VARCHAR(100),
  tax_id          VARCHAR(50),
  address         TEXT,
  city            VARCHAR(100),
  country         VARCHAR(100) NOT NULL DEFAULT 'CM',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  kyc_status      VARCHAR(20) NOT NULL DEFAULT 'not_started'
    CHECK (kyc_status IN ('not_started', 'in_progress', 'verified', 'rejected')),
  invitation_token VARCHAR(255),
  invitation_sent_at TIMESTAMP,
  invitation_accepted_at TIMESTAMP,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_merchants_email ON merchants(email);
CREATE INDEX IF NOT EXISTS idx_merchants_phone_number ON merchants(phone_number);
CREATE INDEX IF NOT EXISTS idx_merchants_status ON merchants(status);
CREATE INDEX IF NOT EXISTS idx_merchants_kyc_status ON merchants(kyc_status);
CREATE INDEX IF NOT EXISTS idx_merchants_invitation_token ON merchants(invitation_token);

-- Auto-update updated_at on merchants
CREATE OR REPLACE FUNCTION update_merchants_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS merchants_updated_at ON merchants;
CREATE TRIGGER merchants_updated_at
  BEFORE UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION update_merchants_updated_at();

-- Merchant batch import jobs tracking
CREATE TABLE IF NOT EXISTS merchant_batch_jobs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          VARCHAR(255) NOT NULL UNIQUE,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  total_records   INTEGER NOT NULL DEFAULT 0,
  processed_records INTEGER NOT NULL DEFAULT 0,
  succeeded_records INTEGER NOT NULL DEFAULT 0,
  failed_records  INTEGER NOT NULL DEFAULT 0,
  errors          JSONB DEFAULT '[]',
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at    TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_merchant_batch_jobs_job_id ON merchant_batch_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_merchant_batch_jobs_status ON merchant_batch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_merchant_batch_jobs_created_at ON merchant_batch_jobs(created_at);