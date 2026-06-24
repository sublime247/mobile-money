-- Migration: 20260529_create_merchant_webhooks
-- Description: Merchant self-serve webhook configuration and delivery history

CREATE TABLE merchant_webhooks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    secret          TEXT NOT NULL,                          -- HMAC-SHA256 signing secret (stored encrypted)
    description     TEXT,
    events          TEXT[] NOT NULL DEFAULT ARRAY[
                        'transaction.completed',
                        'transaction.failed'
                    ],
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_merchant_webhooks_user_id ON merchant_webhooks (user_id);
CREATE INDEX idx_merchant_webhooks_active  ON merchant_webhooks (user_id, is_active);

-- Delivery log: one row per outbound attempt
CREATE TABLE webhook_delivery_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id      UUID NOT NULL REFERENCES merchant_webhooks(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivered', 'failed')),
    http_status     INTEGER,
    response_body   TEXT,
    error_message   TEXT,
    duration_ms     INTEGER,
    is_test         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_webhook_delivery_logs_webhook_id ON webhook_delivery_logs (webhook_id, created_at DESC);
CREATE INDEX idx_webhook_delivery_logs_status     ON webhook_delivery_logs (webhook_id, status);
