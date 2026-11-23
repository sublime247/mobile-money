-- Adds 'pending_review' (AML velocity hold) to the allowed transaction statuses.
-- Also includes 'processing' and 'expired', which the application already uses.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN (
    'pending', 'processing', 'completed', 'failed', 'cancelled',
    'review', 'pending_review', 'dispute', 'reversed', 'clawed_back', 'expired'
  ));
