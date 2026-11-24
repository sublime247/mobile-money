-- Migration: add_kyc_purged_status
-- Description: Extends kyc_applicants.verification_status CHECK constraint to allow
-- 'purged' as a terminal state set by the KYC data retention purge job.
-- The purge job sets this value before hard-deleting the row, but in the
-- unlikely event of a partial failure the row remains clearly marked as purged.

ALTER TABLE kyc_applicants
  DROP CONSTRAINT IF EXISTS kyc_applicants_verification_status_check;

ALTER TABLE kyc_applicants
  ADD CONSTRAINT kyc_applicants_verification_status_check
  CHECK (verification_status IN ('pending', 'approved', 'rejected', 'review', 'purged'));
