-- Migration: Create refresh_token_families table for strict token rotation
CREATE TABLE IF NOT EXISTS refresh_token_families (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id UUID NOT NULL,
    token TEXT NOT NULL,
    parent_token TEXT,
    is_revoked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    revoked_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_refresh_token_families_family_id ON refresh_token_families(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token_families_token ON refresh_token_families(token);