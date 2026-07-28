-- Migration: 20260728_create_webauthn_credentials.sql
-- Adds the webauthn_credentials table used to store registered hardware keys
-- (YubiKey and other FIDO2 authenticators) per user.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owning user
  user_id        UUID        NOT NULL
                              REFERENCES users(id) ON DELETE CASCADE,

  -- Base64url-encoded credential ID produced by the authenticator.
  -- Globally unique; used to look up the credential during authentication.
  credential_id  TEXT        NOT NULL UNIQUE,

  -- COSE-encoded public key (DER / CBOR bytes stored as bytea).
  public_key     BYTEA       NOT NULL,

  -- Monotonically increasing signature counter.  Used to detect cloned keys.
  sign_count     INTEGER     NOT NULL DEFAULT 0,

  -- Optional JSON array of transport hints, e.g. '["usb","nfc"]'.
  transports     TEXT[]      NULL,

  -- Human-readable label set by the user at registration time.
  device_name    TEXT        NULL,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ NULL
);

-- Speed up per-user lookups (listing keys, building allowCredentials lists).
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id
  ON webauthn_credentials (user_id);
