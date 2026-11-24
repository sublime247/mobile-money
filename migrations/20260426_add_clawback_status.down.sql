DO $$
BEGIN
    ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
    ALTER TABLE transactions 
    ADD CONSTRAINT transactions_status_check 
    CHECK (status IN ('pending', 'completed', 'failed', 'cancelled'));
END $$;
