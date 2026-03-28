import dotenv from "dotenv";
import { cleanEnv, str } from "envalid";

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
});

// Re-export specific values for convenience
export const { DATABASE_URL, STELLAR_ISSUER_SECRET, REDIS_URL, STELLAR_HORIZON_URL, STELLAR_NETWORK, DB_ENCRYPTION_KEY } = env;
