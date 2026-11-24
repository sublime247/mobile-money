UPDATE transactions SET status = 'review' WHERE status = 'pending_review';

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN (
    'pending', 'processing', 'completed', 'failed', 'cancelled',
    'review', 'dispute', 'reversed', 'clawed_back', 'expired'
  ));
