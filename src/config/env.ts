import dotenv from "dotenv";
import { cleanEnv, str, bool, num } from "envalid";

// Load environment variables first
dotenv.config();

/**
 * Validates required environment variables at server startup.
 * Fails fast with a clear error message if any required vars are missing.
 */
export const env = cleanEnv(process.env, {
  DATABASE_URL: str({
    desc: "PostgreSQL connection string",
    example: "postgresql://user:password@localhost:5432/dbname",
  }),
  SANDBOX_DATABASE_URL: str({
    desc: "PostgreSQL connection string for sandbox environment",
    example: "postgresql://user:password@localhost:5432/dbname_sandbox",
    default: "",
  }),
  IS_SANDBOX: bool({
    desc: "Whether the application is running in sandbox mode",
    default: false,
  }),
  DR_DATABASE_URL: str({
    desc: "PostgreSQL connection string for disaster recovery / read-replica",
    example: "postgresql://user:password@dr-host:5432/dbname",
    default: "",
  }),
  APP_MAINTENANCE_MODE: bool({
    desc: "Whether the application is in maintenance mode (read-only)",
    default: false,
  }),
  DB_MAX_CONNECTIONS: num({
    desc: "Maximum number of connections in each database pool",
    default: 30,
  }),
  DB_POOL_MAX_USES: num({
    desc: "Maximum number of uses for a pool connection before it is closed and replaced (0 = unlimited)",
    default: 0,
  }),
  DB_POOL_ALLOW_EXIT_ON_IDLE: bool({
    desc: "Allow idle pool connections to exit when not in use",
    default: false,
  }),
  DB_POOL_IDLE_TIMEOUT_MS: num({
    desc: "Idle timeout in milliseconds for primary pool connections",
    default: 30000,
  }),
  DB_POOL_CONNECTION_TIMEOUT_MS: num({
    desc: "Connection timeout in milliseconds for primary pool connections",
    default: 5000,
  }),
  DB_REPLICA_IDLE_TIMEOUT_MS: num({
    desc: "Idle timeout in milliseconds for replica pool connections",
    default: 30000,
  }),
  DB_REPLICA_CONNECTION_TIMEOUT_MS: num({
    desc: "Connection timeout in milliseconds for replica pool connections",
    default: 500,
  }),
  INDEX_REINDEX_JOB_ENABLED: bool({
    default: true,
    desc: "Whether the automated index reindex maintenance job should run",
  }),
  INDEX_REINDEX_CRON: str({
    default: "0 3 * * *",
    desc: "Cron schedule for the automated index reindex maintenance job",
    example: "0 3 * * *",
  }),
  INDEX_REINDEX_MIN_SIZE_MB: num({
    default: 100,
    desc: "Minimum size in MB for an index to be eligible for automatic reindexing",
  }),
  INDEX_REINDEX_MAX_SCAN_COUNT: num({
    default: 50,
    desc: "Maximum scan count for an index to still be eligible for automatic reindexing",
  }),
  INDEX_REINDEX_MAX_ACTIVE_CONNECTIONS: num({
    default: 5,
    desc: "Maximum active queries allowed in the database before the automatic index reindex job is skipped",
  }),
  STELLAR_ISSUER_SECRET: str({
    desc: "Stellar secret key for the issuer account",
    example: "S...",
  }),
  REDIS_URL: str({
    desc: "Redis connection URL for queue and locks",
    example: "re8dis://localhost:6379",
  }),
  STELLAR_HORIZON_URL: str({
    default: "https://horizon-testnet.stellar.org",
    desc: "Stellar Horizon server URL, or a comma-separated list of URLs (primary first, then fallbacks) for automatic node rotation/failover",
  }),
  STELLAR_NETWORK: str({
    default: "testnet",
    desc: "Stellar network (testnet or mainnet)",
  }),
  DB_ENCRYPTION_KEY: str({
    default: "development-encryption-key-32-chars-long",
    desc: "Secret key for PII encryption in database (AES-256-GCM global key material)",
  }),
  PII_MASTER_KEY: str({
    default: "development-pii-master-key-32-chars!",
    desc: "Master key for per-user HKDF key derivation. Must be a high-entropy secret in production. Never log or expose this value.",
  }),
  REFRESH_TOKEN_EXPIRES_IN: str({
    default: process.env.REFRESH_TOKEN_EXPIRES_IN,
    desc: "REFRESH_TOKEN_EXPIRES_IN needs to be set in environment file",
  }),
  REFRESH_TOKEN_SECRET: str({
    default: process.env.REFRESH_TOKEN_SECRET,
    desc: "REFRESH_TOKEN_SECRET needs to be set in environment file",
  }),
  REFRESH_TOKEN_ISSUER: str({
    default: process.env.REFRESH_TOKEN_ISSUER,
    desc: "REFRESH_TOKEN_ISSUER needs to be set in environment file",
  }),
  REFRESH_TOKEN_AUDIENCE: str({
    default: process.env.REFRESH_TOKEN_AUDIENCE,
    desc: "REFRESH_TOKEN_AUDIENCE needs to be set in environment file",
  }),
  PAGERDUTY_INTEGRATION_KEY: str({
    default: "",
    desc: "PagerDuty Events API V2 Integration Key for alert routing",
    example: "R1234567890abcdef",
  }),
  PAGERDUTY_DEDUP_KEY: str({
    default: "mobile-money",
    desc: "PagerDuty deduplication key prefix for incident grouping",
  }),
  ADMIN_API_KEY: str({
    default: "",
    desc: "Admin API key for internal tooling",
    example: "admin-secret-key",
  }),
  APQ_TTL_SECONDS: str({
    default: "86400",
    desc: "TTL in seconds for Automatic Persisted Query entries in Redis (default: 86400 = 24h)",
  }),
  AML_API_KEY: str({
    default: "",
    desc: "API key for third-party AML/sanction screening provider (e.g. Elliptic, Chainalysis)",
    example: "ell_live_xxxxxxxxxxxx",
  }),
  QUICKBOOKS_CLIENT_ID: str({
    default: "",
    desc: "QuickBooks Online OAuth 2.0 Client ID",
  }),
  QUICKBOOKS_CLIENT_SECRET: str({
    default: "",
    desc: "QuickBooks Online OAuth 2.0 Client Secret",
  }),
  QUICKBOOKS_REDIRECT_URI: str({
    default: "http://localhost:3000/api/accounting/quickbooks/callback",
    desc: "QuickBooks Online OAuth 2.0 Redirect URI",
  }),
  XERO_CLIENT_ID: str({
    default: "",
    desc: "Xero OAuth 2.0 Client ID",
  }),
  XERO_CLIENT_SECRET: str({
    default: "",
    desc: "Xero OAuth 2.0 Client Secret",
  }),
  XERO_REDIRECT_URI: str({
    default: "http://localhost:3000/api/accounting/xero/callback",
    desc: "Xero OAuth 2.0 Redirect URI",
  }),
  TRANSACTION_WORKER_CONCURRENCY: num({
    default: 50,
    desc: "Transaction worker concurrency limit for parallel job processing",
  }),
  SYNC_WORKER_CONCURRENCY: num({
    default: 20,
    desc: "Accounting sync worker concurrency limit",
  }),
  WEBHOOK_RETRY_WORKER_CONCURRENCY: num({
    default: 10,
    desc: "Webhook retry worker concurrency limit",
  }),
  ACCOUNTING_RETRY_WORKER_CONCURRENCY: num({
    default: 5,
    desc: "Accounting retry worker concurrency limit",
  }),
  ACCOUNTING_TOKEN_REFRESH_WORKER_CONCURRENCY: num({
    default: 3,
    desc: "Accounting token refresh worker concurrency limit",
  }),
  PROVIDER_BALANCE_ALERT_WORKER_CONCURRENCY: num({
    default: 1,
    desc: "Provider balance alert worker concurrency limit (default 1 – sequential to prevent duplicate alerts)",
  }),
  MINIMUM_FLOAT_BALANCE: num({
    default: 500,
    desc: "Minimum float balance threshold in smallest currency unit (e.g. XAF kobo). Payouts will be held if balance falls below this amount",
  }),
});

// Re-export specific values for convenience
export const {
  DATABASE_URL,
  SANDBOX_DATABASE_URL,
  IS_SANDBOX,
  DR_DATABASE_URL,
  STELLAR_ISSUER_SECRET,
  REDIS_URL,
  STELLAR_HORIZON_URL,
  STELLAR_NETWORK,
  DB_ENCRYPTION_KEY,
  PII_MASTER_KEY,
  PAGERDUTY_INTEGRATION_KEY,
  PAGERDUTY_DEDUP_KEY,
  ADMIN_API_KEY,
  APP_MAINTENANCE_MODE,
  INDEX_REINDEX_JOB_ENABLED,
  INDEX_REINDEX_CRON,
  INDEX_REINDEX_MIN_SIZE_MB,
  INDEX_REINDEX_MAX_SCAN_COUNT,
  INDEX_REINDEX_MAX_ACTIVE_CONNECTIONS,
  QUICKBOOKS_CLIENT_ID,
  QUICKBOOKS_CLIENT_SECRET,
  QUICKBOOKS_REDIRECT_URI,
  XERO_CLIENT_ID,
  XERO_CLIENT_SECRET,
  XERO_REDIRECT_URI,
  TRANSACTION_WORKER_CONCURRENCY,
  SYNC_WORKER_CONCURRENCY,
  WEBHOOK_RETRY_WORKER_CONCURRENCY,
  ACCOUNTING_RETRY_WORKER_CONCURRENCY,
  ACCOUNTING_TOKEN_REFRESH_WORKER_CONCURRENCY,
  PROVIDER_BALANCE_ALERT_WORKER_CONCURRENCY,
  MINIMUM_FLOAT_BALANCE,
} = env;
