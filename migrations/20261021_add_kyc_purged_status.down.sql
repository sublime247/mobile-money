-- Preserve any rows left by an incomplete purge. If such rows still exist,
-- restoring the previous constraint fails and the migration is rolled back.
ALTER TABLE kyc_applicants
  DROP CONSTRAINT IF EXISTS kyc_applicants_verification_status_check,
  ADD CONSTRAINT kyc_applicants_verification_status_check
    CHECK (verification_status IN ('pending', 'approved', 'rejected', 'review'));
