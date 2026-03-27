-- Migration to create provider_performance_logs table
CREATE TABLE IF NOT EXISTS provider_performance_logs (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL,
    operation VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,
    duration_ms INTEGER NOT NULL,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Optional: Index for historical analysis
CREATE INDEX IF NOT EXISTS idx_provider_performance_provider ON provider_performance_logs(provider);
CREATE INDEX IF NOT EXISTS idx_provider_performance_created_at ON provider_performance_logs(created_at);
