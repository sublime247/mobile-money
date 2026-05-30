-- Migration: Multi-Sig Key Recovery Safe Protocol
-- Created at: 2026-05-30
-- Purpose: Database tables for SEP-30 managed keys with multi-sig recovery state machine.
--
-- Recovery state machine transitions:
--   pending → collecting_approvals → awaiting_completion → completed
--                                  ↘ rejected (if cancelled or threshold not met in time)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Managed Keys ───────────────────────────────────────────────────────────
-- Stores encrypted Stellar key pairs on behalf of users.
-- Secret keys are AES-256-GCM encrypted — never stored in plaintext.

CREATE TABLE IF NOT EXISTS managed_keys (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key          VARCHAR(56)   NOT NULL,
  -- JSON: { ciphertext, iv, tag, salt, algorithm }
  encrypted_secret    TEXT          NOT NULL,
  -- M-of-N: how many recovery signers must approve recovery
  recovery_threshold  INT           NOT NULL DEFAULT 1 CHECK (recovery_threshold >= 1),
  is_active           BOOLEAN       NOT NULL DEFAULT true,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_managed_keys_user_id   ON managed_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_managed_keys_public_key ON managed_keys(public_key);
CREATE INDEX IF NOT EXISTS idx_managed_keys_active     ON managed_keys(user_id, is_active);

-- ── 2. Recovery Signers ───────────────────────────────────────────────────────
-- Registered guardian / device keys that can approve recovery.

CREATE TABLE IF NOT EXISTS recovery_signers (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  managed_key_id      UUID          NOT NULL REFERENCES managed_keys(id) ON DELETE CASCADE,
  signer_public_key   VARCHAR(56)   NOT NULL,
  signer_label        VARCHAR(100)  NOT NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (managed_key_id, signer_public_key)
);

CREATE INDEX IF NOT EXISTS idx_recovery_signers_key_id ON recovery_signers(managed_key_id);

-- ── 3. Recovery Tokens ────────────────────────────────────────────────────────
-- Short-lived challenge tokens issued per signer per recovery attempt.
-- Only the SHA-256 hash is stored — the raw token is returned once and discarded.

CREATE TABLE IF NOT EXISTS recovery_tokens (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  managed_key_id      UUID          NOT NULL REFERENCES managed_keys(id) ON DELETE CASCADE,
  -- SHA-256 hash of the raw challenge token
  token_hash          VARCHAR(64)   NOT NULL,
  signer_public_key   VARCHAR(56)   NOT NULL,
  expires_at          TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at             TIMESTAMP WITH TIME ZONE,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recovery_tokens_key_id  ON recovery_tokens(managed_key_id);
CREATE INDEX IF NOT EXISTS idx_recovery_tokens_expires  ON recovery_tokens(expires_at) WHERE used_at IS NULL;

-- ── 4. Key Recovery Sessions ─────────────────────────────────────────────────
-- The core multi-sig state machine.  One session = one recovery attempt.
-- Tracks which signers have approved and what state the flow is in.
--
-- State machine:
--   pending              → collecting_approvals (first signer approves)
--   collecting_approvals → awaiting_completion  (threshold reached)
--   awaiting_completion  → completed            (POST /complete called)
--   *                    → rejected             (expired TTL or cancelled)

CREATE TYPE recovery_session_state AS ENUM (
  'pending',
  'collecting_approvals',
  'awaiting_completion',
  'completed',
  'rejected'
);

CREATE TABLE IF NOT EXISTS key_recovery_sessions (
  id                    UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  managed_key_id        UUID                   NOT NULL REFERENCES managed_keys(id) ON DELETE CASCADE,

  -- Immutable snapshot of the threshold at session creation time
  required_approvals    INT                    NOT NULL CHECK (required_approvals >= 1),

  -- Current FSM state
  state                 recovery_session_state NOT NULL DEFAULT 'pending',

  -- Array of signer public keys that have submitted valid signatures
  -- Updated atomically as approvals come in
  approved_by           TEXT[]                 NOT NULL DEFAULT '{}',

  -- Optional: new Stellar address to rotate to after recovery (NULL = generate fresh)
  requested_new_address VARCHAR(56),

  -- Requestor metadata
  initiated_by_ip       INET,
  initiated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Session expires if threshold not met within this window
  expires_at            TIMESTAMP WITH TIME ZONE NOT NULL
                          DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 minutes'),

  -- Populated on terminal states
  completed_at          TIMESTAMP WITH TIME ZONE,
  rejected_reason       TEXT,

  -- Audit trail: new public key written after key rotation
  new_public_key        VARCHAR(56),
  old_public_key        VARCHAR(56),

  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_krs_managed_key_id ON key_recovery_sessions(managed_key_id);
CREATE INDEX IF NOT EXISTS idx_krs_state          ON key_recovery_sessions(state);
CREATE INDEX IF NOT EXISTS idx_krs_active         ON key_recovery_sessions(managed_key_id, state)
  WHERE state NOT IN ('completed', 'rejected');

-- ── 5. Recovery Session Audit Log ─────────────────────────────────────────────
-- Append-only log of every state transition for compliance / forensics.

CREATE TABLE IF NOT EXISTS key_recovery_audit_log (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID    NOT NULL REFERENCES key_recovery_sessions(id) ON DELETE CASCADE,
  -- e.g. "initiate", "approve", "threshold_reached", "complete", "reject", "expire"
  event_type    VARCHAR(30)  NOT NULL,
  signer_public_key  VARCHAR(56),
  from_state    recovery_session_state,
  to_state      recovery_session_state,
  metadata      JSONB,
  occurred_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address    INET
);

CREATE INDEX IF NOT EXISTS idx_kra_session_id  ON key_recovery_audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_kra_occurred_at ON key_recovery_audit_log(occurred_at);

-- ── 6. Auto-update updated_at triggers ───────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER managed_keys_updated_at
  BEFORE UPDATE ON managed_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER key_recovery_sessions_updated_at
  BEFORE UPDATE ON key_recovery_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
