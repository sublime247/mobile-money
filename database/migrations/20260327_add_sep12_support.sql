-- Add stellar_address to users table for SEP-12 support
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS stellar_address VARCHAR(56);

CREATE INDEX IF NOT EXISTS idx_users_stellar_address ON users(stellar_address);

-- Create kyc_applicants table if it doesn't exist
CREATE TABLE IF NOT EXISTS kyc_applicants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applicant_id VARCHAR(255) NOT NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'entrust',
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'approved', 'rejected', 'review')),
  kyc_level VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (kyc_level IN ('none', 'basic', 'full')),
  applicant_data JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, applicant_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_kyc_applicants_user_id ON kyc_applicants(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_applicants_applicant_id ON kyc_applicants(applicant_id);
CREATE INDEX IF NOT EXISTS idx_kyc_applicants_verification_status ON kyc_applicants(verification_status);
CREATE INDEX IF NOT EXISTS idx_kyc_applicants_updated_at ON kyc_applicants(updated_at);

-- Auto-update updated_at on kyc_applicants
CREATE OR REPLACE FUNCTION update_kyc_applicants_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kyc_applicants_updated_at ON kyc_applicants;
CREATE TRIGGER kyc_applicants_updated_at
  BEFORE UPDATE ON kyc_applicants
  FOR EACH ROW EXECUTE FUNCTION update_kyc_applicants_updated_at();

-- Add comment for documentation
COMMENT ON TABLE kyc_applicants IS 'Links users to KYC provider applicants for SEP-12 compliance';
COMMENT ON COLUMN kyc_applicants.applicant_id IS 'External KYC provider applicant ID';
COMMENT ON COLUMN kyc_applicants.verification_status IS 'Current verification status from KYC provider';
COMMENT ON COLUMN kyc_applicants.kyc_level IS 'Achieved KYC verification level';
