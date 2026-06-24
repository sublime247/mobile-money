-- Migration: 20260423_create_double_entry_ledger
-- Description: Implement immutable double-entry ledger system for financial integrity
-- This migration creates accounts and ledger_entries tables with atomic posting logic

-- ============================================================================
-- ACCOUNTS TABLE
-- ============================================================================
-- Represents financial accounts in the system (assets, liabilities, equity, revenue, expenses)
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_balance VARCHAR(10) NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  parent_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounts_code ON accounts(code);
CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(type);
CREATE INDEX IF NOT EXISTS idx_accounts_parent_id ON accounts(parent_id);
CREATE INDEX IF NOT EXISTS idx_accounts_is_active ON accounts(is_active);

-- Auto-update updated_at on accounts
CREATE OR REPLACE FUNCTION update_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accounts_updated_at ON accounts;
CREATE TRIGGER accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION update_accounts_updated_at();

-- ============================================================================
-- LEDGER_ENTRIES TABLE (Immutable)
-- ============================================================================
-- Immutable double-entry ledger entries - once posted, never modified
CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  debit_amount DECIMAL(20, 7) NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
  credit_amount DECIMAL(20, 7) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  transaction_id UUID,
  reference_number VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  posted_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Ensure exactly one of debit or credit is non-zero (not both)
  CONSTRAINT check_debit_or_credit CHECK (
    (debit_amount > 0 AND credit_amount = 0) OR 
    (credit_amount > 0 AND debit_amount = 0)
  )
);

-- Prevent updates and deletes on ledger_entries (immutability)
CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Ledger entries are immutable and cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_ledger_update ON ledger_entries;
CREATE TRIGGER prevent_ledger_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();

DROP TRIGGER IF EXISTS prevent_ledger_delete ON ledger_entries;
CREATE TRIGGER prevent_ledger_delete
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_date ON ledger_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction_id ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_reference_number ON ledger_entries(reference_number);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_created_at ON ledger_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_date ON ledger_entries(account_id, entry_date DESC);

-- ============================================================================
-- ACCOUNT BALANCES MATERIALIZED VIEW
-- ============================================================================
-- Materialized view for fast balance lookups
CREATE MATERIALIZED VIEW IF NOT EXISTS account_balances AS
SELECT 
  a.id AS account_id,
  a.code,
  a.name,
  a.type,
  a.normal_balance,
  COALESCE(SUM(le.debit_amount), 0) AS total_debits,
  COALESCE(SUM(le.credit_amount), 0) AS total_credits,
  CASE 
    WHEN a.normal_balance = 'debit' THEN 
      COALESCE(SUM(le.debit_amount), 0) - COALESCE(SUM(le.credit_amount), 0)
    ELSE 
      COALESCE(SUM(le.credit_amount), 0) - COALESCE(SUM(le.debit_amount), 0)
  END AS balance,
  MAX(le.created_at) AS last_entry_at
FROM accounts a
LEFT JOIN ledger_entries le ON a.id = le.account_id
WHERE a.is_active = true
GROUP BY a.id, a.code, a.name, a.type, a.normal_balance;

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_balances_account_id ON account_balances(account_id);
CREATE INDEX IF NOT EXISTS idx_account_balances_type ON account_balances(type);

-- Function to refresh account balances
CREATE OR REPLACE FUNCTION refresh_account_balances()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY account_balances;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- ATOMIC POST_TRANSACTION FUNCTION
-- ============================================================================
-- Posts a complete double-entry transaction atomically
-- Ensures debits = credits before committing
CREATE OR REPLACE FUNCTION post_transaction(
  p_reference_number VARCHAR(50),
  p_description TEXT,
  p_transaction_id UUID,
  p_posted_by UUID,
  p_entries JSONB -- Array of {account_code, debit_amount, credit_amount, description}
)
RETURNS TABLE(entry_id UUID, account_code VARCHAR, debit DECIMAL, credit DECIMAL) AS $$
  DECLARE
    v_account_id UUID;
    v_total_debits DECIMAL(20, 7) := 0;
    v_total_credits DECIMAL(20, 7) := 0;
    v_entry JSONB;
    v_new_entry_id UUID;
  BEGIN
    -- Validate inputs
    IF p_entries IS NULL OR p_entries = '[]'::JSONB THEN
      RAISE EXCEPTION 'At least one ledger entry is required';
    END IF;

    IF jsonb_array_length(p_entries) < 2 THEN
      RAISE EXCEPTION 'Double-entry requires at least 2 entries (debit and credit)';
    END IF;

    -- Calculate totals and validate each entry
    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
      -- Get account ID from code
      SELECT id INTO v_account_id
      FROM accounts
      WHERE code = (v_entry->>'account_code')
        AND is_active = true;
      
      IF v_account_id IS NULL THEN
        RAISE EXCEPTION 'Account not found or inactive: %', (v_entry->>'account_code');
      END IF;

      -- Accumulate totals
      v_total_debits := v_total_debits + COALESCE((v_entry->>'debit_amount')::DECIMAL(20, 7), 0);
      v_total_credits := v_total_credits + COALESCE((v_entry->>'credit_amount')::DECIMAL(20, 7), 0);
    END LOOP;

    -- Validate double-entry balance (debits must equal credits)
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
        metadata
      ) VALUES (
        v_account_id,
        COALESCE((v_entry->>'debit_amount')::DECIMAL(20, 7), 0),
        COALESCE((v_entry->>'credit_amount')::DECIMAL(20, 7), 0),
        p_transaction_id,
        p_reference_number,
        COALESCE(v_entry->>'description', p_description),
        p_posted_by,
        COALESCE(v_entry->'metadata', '{}'::JSONB)
      )
      RETURNING id INTO v_new_entry_id;

      -- Return the created entry
      RETURN QUERY
      SELECT 
        v_new_entry_id,
        (v_entry->>'account_code')::VARCHAR,
        COALESCE((v_entry->>'debit_amount')::DECIMAL(20, 7), 0),
        COALESCE((v_entry->>'credit_amount')::DECIMAL(20, 7), 0);
    END LOOP;

    RETURN;
  END;
  $$ LANGUAGE plpgsql;

-- ============================================================================
-- SEED STANDARD CHART OF ACCOUNTS
-- ============================================================================
-- Insert standard accounts for mobile money operations
INSERT INTO accounts (code, name, type, normal_balance, description) VALUES
  -- Assets
  ('1000', 'Cash and Cash Equivalents', 'asset', 'debit', 'Main cash account'),
  ('1100', 'Mobile Money Float', 'asset', 'debit', 'Mobile money provider float balance'),
  ('1200', 'Stellar Asset Holdings', 'asset', 'debit', 'Stellar blockchain asset holdings'),
  ('1300', 'Accounts Receivable', 'asset', 'debit', 'Amounts owed by customers'),
  ('1400', 'Pending Deposits', 'asset', 'debit', 'Deposits in transit'),
  
  -- Liabilities
  ('2000', 'Customer Balances', 'liability', 'credit', 'Total customer balances owed'),
  ('2100', 'Pending Withdrawals', 'liability', 'credit', 'Withdrawals in process'),
  ('2200', 'Provider Payables', 'liability', 'credit', 'Amounts owed to mobile money providers'),
  ('2300', 'Vault Balances', 'liability', 'credit', 'Customer vault balances'),
  
  -- Equity
  ('3000', 'Owner Equity', 'equity', 'credit', 'Owner equity account'),
  ('3100', 'Retained Earnings', 'equity', 'credit', 'Accumulated retained earnings'),
  
  -- Revenue
  ('4000', 'Transaction Fee Revenue', 'revenue', 'credit', 'Fees earned from transactions'),
  ('4100', 'Deposit Fee Revenue', 'revenue', 'credit', 'Fees from deposit transactions'),
  ('4200', 'Withdrawal Fee Revenue', 'revenue', 'credit', 'Fees from withdrawal transactions'),
  ('4300', 'Exchange Rate Revenue', 'revenue', 'credit', 'Revenue from currency exchange spreads'),
  
  -- Expenses
  ('5000', 'Provider Transaction Fees', 'expense', 'debit', 'Fees paid to mobile money providers'),
  ('5100', 'Stellar Network Fees', 'expense', 'debit', 'Fees paid to Stellar network'),
  ('5200', 'Operational Expenses', 'expense', 'debit', 'General operational costs'),
  ('5300', 'Dispute Losses', 'expense', 'debit', 'Losses from disputed transactions')
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- RECONCILIATION HELPER FUNCTIONS
-- ============================================================================

-- Check if ledger is balanced (total debits = total credits)
CREATE OR REPLACE FUNCTION check_ledger_balance()
RETURNS TABLE(
  total_debits DECIMAL(20, 7),
  total_credits DECIMAL(20, 7),
  difference DECIMAL(20, 7),
  is_balanced BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(SUM(debit_amount), 0) AS total_debits,
    COALESCE(SUM(credit_amount), 0) AS total_credits,
    COALESCE(SUM(debit_amount), 0) - COALESCE(SUM(credit_amount), 0) AS difference,
    COALESCE(SUM(debit_amount), 0) = COALESCE(SUM(credit_amount), 0) AS is_balanced
  FROM ledger_entries;
END;
$$ LANGUAGE plpgsql;

-- Get trial balance (all account balances)
CREATE OR REPLACE FUNCTION get_trial_balance(p_as_of_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE(
  account_code VARCHAR,
  account_name VARCHAR,
  account_type VARCHAR,
  debit_balance DECIMAL(20, 7),
  credit_balance DECIMAL(20, 7)
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.code,
    a.name,
    a.type,
    CASE 
      WHEN a.normal_balance = 'debit' THEN 
        GREATEST(COALESCE(SUM(le.debit_amount), 0) - COALESCE(SUM(le.credit_amount), 0), 0)
      ELSE 0
    END AS debit_balance,
    CASE 
      WHEN a.normal_balance = 'credit' THEN 
        GREATEST(COALESCE(SUM(le.credit_amount), 0) - COALESCE(SUM(le.debit_amount), 0), 0)
      ELSE 0
    END AS credit_balance
  FROM accounts a
  LEFT JOIN ledger_entries le ON a.id = le.account_id AND le.entry_date <= p_as_of_date
  WHERE a.is_active = true
  GROUP BY a.id, a.code, a.name, a.type, a.normal_balance
  ORDER BY a.code;
END;
$$ LANGUAGE plpgsql;

-- Get account balance at a specific date
CREATE OR REPLACE FUNCTION get_account_balance(
  p_account_code VARCHAR,
  p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS DECIMAL(20, 7) AS $$
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
  WHERE a.code = p_account_code AND le.entry_date <= p_as_of_date;

  RETURN COALESCE(v_balance, 0);
END;
$$ LANGUAGE plpgsql;
