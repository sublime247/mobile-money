import dotenv from "dotenv";
import { cleanEnv, str, bool } from "envalid";

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
    desc: "Stellar Horizon server URL",
  }),
  STELLAR_NETWORK: str({
    default: "testnet",
    desc: "Stellar network (testnet or mainnet)",
  }),
  DB_ENCRYPTION_KEY: str({
    default: "development-encryption-key-32-chars-long",
    desc: "Secret key for PII encryption in database",
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
    desc: "Administrative API key for system operations",
    example: "your-secure-admin-api-key-here",
  }),
});

// Re-export specific values for convenience
export const {
  DATABASE_URL,
  STELLAR_ISSUER_SECRET,
  REDIS_URL,
  STELLAR_HORIZON_URL,
  STELLAR_NETWORK,
  DB_ENCRYPTION_KEY,
  PAGERDUTY_INTEGRATION_KEY,
  PAGERDUTY_DEDUP_KEY,
  ADMIN_API_KEY,
} = env;
