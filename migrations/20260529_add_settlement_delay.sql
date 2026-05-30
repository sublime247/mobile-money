-- Migration: 20260529_add_settlement_delay
-- Description: Implement Settlement Delay Logic (T+N)

-- 1. Add settlement_delay_days to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS settlement_delay_days INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_settlement_delay ON users(settlement_delay_days);

-- 2. Add settlement_date to ledger_entries
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS settlement_date DATE NOT NULL DEFAULT CURRENT_DATE;
CREATE INDEX IF NOT EXISTS idx_ledger_entries_settlement_date ON ledger_entries(settlement_date);

-- 3. Update post_transaction to support settlement_date
CREATE OR REPLACE FUNCTION post_transaction(
  p_reference_number VARCHAR(50),
  p_description TEXT,
  p_transaction_id UUID,
  p_posted_by UUID,
  p_entries JSONB
)
RETURNS TABLE(entry_id UUID, account_code VARCHAR, debit DECIMAL, credit DECIMAL) AS $BODY$
DECLARE
  v_total_debits DECIMAL(20, 7) := 0;
  v_total_credits DECIMAL(20, 7) := 0;
  v_entry JSONB;
  v_account_id UUID;
  v_new_entry_id UUID;
BEGIN
  -- Validate inputs
  IF p_entries IS NULL OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'At least one ledger entry is required';
  END IF;

  IF jsonb_array_length(p_entries) < 2 THEN
    RAISE EXCEPTION 'Double-entry requires at least 2 entries (debit and credit)';
  END IF;

  -- Calculate totals and validate each entry
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    SELECT id INTO v_account_id
    FROM accounts
    WHERE code = (v_entry->>'account_code')
      AND is_active = true;
    
    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'Account not found or inactive: %', (v_entry->>'account_code');
    END IF;

    v_total_debits := v_total_debits + COALESCE((v_entry->>'debit_amount')::DECIMAL(20, 7), 0);
    v_total_credits := v_total_credits + COALESCE((v_entry->>'credit_amount')::DECIMAL(20, 7), 0);
  END LOOP;

  IF v_total_debits != v_total_credits THEN
    RAISE EXCEPTION 'Transaction is not balanced: debits=% credits=%', v_total_debits, v_total_credits;
  END IF;

  IF v_total_debits = 0 THEN
    RAISE EXCEPTION 'Transaction amounts cannot be zero';
  END IF;

  -- Insert all ledger entries atomically
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    SELECT id INTO v_account_id
    FROM accounts
    WHERE code = (v_entry->>'account_code');

    INSERT INTO ledger_entries (
      account_id,
      debit_amount,
      credit_amount,
      transaction_id,
      reference_number,
      description,
      posted_by,
      metadata,
      settlement_date
    ) VALUES (
      v_account_id,
      COALESCE((v_entry->>'debit_amount')::DECIMAL(20, 7), 0),
      COALESCE((v_entry->>'credit_amount')::DECIMAL(20, 7), 0),
      p_transaction_id,
      p_reference_number,
      COALESCE(v_entry->>'description', p_description),
      p_posted_by,
      COALESCE(v_entry->'metadata', '{}'::JSONB),
      COALESCE((v_entry->>'settlement_date')::DATE, CURRENT_DATE)
    )
    RETURNING id INTO v_new_entry_id;

    RETURN QUERY
    SELECT 
      v_new_entry_id,
      (v_entry->>'account_code')::VARCHAR,
      COALESCE((v_entry->>'debit_amount')::DECIMAL(20, 7), 0),
      COALESCE((v_entry->>'credit_amount')::DECIMAL(20, 7), 0);
  END LOOP;

  RETURN;
END;
$BODY$ LANGUAGE plpgsql;

-- 4. Create function to get available balance (settled funds)
CREATE OR REPLACE FUNCTION get_available_balance(
  p_account_code VARCHAR,
  p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS DECIMAL(20, 7) AS $BODY$
DECLARE
  v_balance DECIMAL(20, 7);
  v_normal_balance VARCHAR(10);
BEGIN
  SELECT normal_balance INTO v_normal_balance
  FROM accounts
  WHERE code = p_account_code AND is_active = true;
  
  IF v_normal_balance IS NULL THEN
    RAISE EXCEPTION 'Account not found: %', p_account_code;
  END IF;

  SELECT 
    CASE 
      WHEN v_normal_balance = 'debit' THEN 
        COALESCE(SUM(le.debit_amount), 0) - COALESCE(SUM(le.credit_amount), 0)
      ELSE 
        COALESCE(SUM(le.credit_amount), 0) - COALESCE(SUM(le.debit_amount), 0)
    END
  INTO v_balance
  FROM ledger_entries le
  JOIN accounts a ON le.account_id = a.id
  WHERE a.code = p_account_code 
    AND le.entry_date <= p_as_of_date
    AND le.settlement_date <= p_as_of_date;

  RETURN COALESCE(v_balance, 0);
END;
$BODY$ LANGUAGE plpgsql;

-- 5. Create function to get pending balance (unsettled funds)
CREATE OR REPLACE FUNCTION get_pending_balance(
  p_account_code VARCHAR,
  p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS DECIMAL(20, 7) AS $BODY$
DECLARE
  v_balance DECIMAL(20, 7);
  v_normal_balance VARCHAR(10);
BEGIN
  SELECT normal_balance INTO v_normal_balance
  FROM accounts
  WHERE code = p_account_code AND is_active = true;
  
  IF v_normal_balance IS NULL THEN
    RAISE EXCEPTION 'Account not found: %', p_account_code;
  END IF;

  SELECT 
    CASE 
      WHEN v_normal_balance = 'debit' THEN 
        COALESCE(SUM(le.debit_amount), 0) - COALESCE(SUM(le.credit_amount), 0)
      ELSE 
        COALESCE(SUM(le.credit_amount), 0) - COALESCE(SUM(le.debit_amount), 0)
    END
  INTO v_balance
  FROM ledger_entries le
  JOIN accounts a ON le.account_id = a.id
  WHERE a.code = p_account_code 
    AND le.entry_date <= p_as_of_date
    AND le.settlement_date > p_as_of_date;

  RETURN COALESCE(v_balance, 0);
END;
$BODY$ LANGUAGE plpgsql;

