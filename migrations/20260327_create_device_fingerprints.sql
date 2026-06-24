-- Create device_fingerprints table
CREATE TABLE IF NOT EXISTS device_fingerprints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fingerprint VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_device_fingerprints_user_id ON device_fingerprints(user_id);
CREATE UNIQUE INDEX idx_device_fingerprints_user_fingerprint ON device_fingerprints(user_id, fingerprint);
