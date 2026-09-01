import convict from "convict";
import * as path from "path";
import * as fs from "fs";

/**
 * Centralized application configuration using Convict.
 * This system consolidates all hardcoded limits, provider configs, and app settings
 * into a single source of truth with environment-based overrides.
 * 
 * NOTE: Orange Money Cameroon configuration placeholders added for future corridor expansion.
 */

// Define the configuration schema
export const configSchema = convict({
  // Environment
  env: {
    doc: "The application environment",
    format: ["production", "staging", "development", "test"],
    default: "development",
    env: "NODE_ENV",
  },
  isSandbox: {
    doc: "Whether the application is running in sandbox mode",
    format: Boolean,
    default: false,
    env: "IS_SANDBOX",
  },
  maintenance: {
    enabled: {
      doc: "Whether the application is in maintenance mode (read-only)",
      format: Boolean,
      default: false,
      env: "APP_MAINTENANCE_MODE",
    },
  },

  // Stellar / Horizon
  stellar: {
    horizonUrl: {
      doc: "Primary Stellar Horizon server URL",
      format: String,
      default: "https://horizon-testnet.stellar.org",
      env: "STELLAR_HORIZON_URL",
    },
    fallbackHorizonUrls: {
      doc: "Comma-separated list of secondary fallback Stellar Horizon server URLs",
      format: String,
      default: "",
      env: "STELLAR_FALLBACK_HORIZON_URLS",
    },
  },

  // Database
  database: {
    url: {
      doc: "PostgreSQL connection URL",
      format: String,
      default: "postgresql://localhost/mobile_money",
      env: "DATABASE_URL",
    },
    sandboxUrl: {
      doc: "PostgreSQL connection URL for sandbox environment",
      format: String,
      default: "postgresql://localhost/mobile_money_sandbox",
      env: "SANDBOX_DATABASE_URL",
    },
  },

  // Redis
  redis: {
    url: {
      doc: "Redis connection URL",
      format: String,
      default: "redis://localhost:6379",
      env: "REDIS_URL",
    },
  },

  // Transaction Limits by KYC Tier
  transactionLimits: {
    unverified: {
      doc: "Daily transaction limit for unverified tier (XAF)",
      format: "nat",
      default: 50000,
      env: "LIMIT_UNVERIFIED",
    },
    basic: {
      doc: "Daily transaction limit for basic KYC tier (XAF)",
      format: "nat",
      default: 200000,
      env: "LIMIT_BASIC",
    },
    full: {
      doc: "Daily transaction limit for full KYC tier (XAF)",
      format: "nat",
      default: 1000000,
      env: "LIMIT_FULL",
    },
  },

  // Per-Transaction Min/Max Limits
  transactions: {
    minAmount: {
      doc: "Global minimum transaction amount (XAF)",
      format: "nat",
      default: 100,
      env: "MIN_TRANSACTION_AMOUNT",
    },
    maxAmount: {
      doc: "Global maximum transaction amount (XAF)",
      format: "nat",
      default: 5000000,
      env: "MAX_TRANSACTION_AMOUNT",
    },
  },

  // Logging
  logging: {
    enableSlowQueryLogging: {
      doc: "Whether to enable slow query logging",
      format: Boolean,
      default: false,
      env: "ENABLE_SLOW_QUERY_LOGGING",
    },
  },

  // CORS
  cors: {
    allowedOrigins: {
      doc: "Allowed CORS origins",
      format: Array,
      default: ["http://localhost:3000"],
      env: "CORS_ALLOWED_ORIGINS",
    },
  },

  // Workers
  worker: {
    concurrency: {
      doc: "Worker job concurrency",
      format: "nat",
      default: 50,
      env: "WORKER_CONCURRENCY",
    },
    syncConcurrency: {
      doc: "Sync worker concurrency",
      format: "nat",
      default: 20,
      env: "SYNC_CONCURRENCY",
    },
    webhookRetryConcurrency: {
      doc: "Webhook retry concurrency",
      format: "nat",
      default: 10,
      env: "WEBHOOK_RETRY_CONCURRENCY",
    },
    accountingRetryConcurrency: {
      doc: "Accounting retry concurrency",
      format: "nat",
      default: 5,
      env: "ACCOUNTING_RETRY_CONCURRENCY",
    },
    accountingTokenRefreshConcurrency: {
      doc: "Accounting token refresh concurrency",
      format: "nat",
      default: 3,
      env: "ACCOUNTING_TOKEN_REFRESH_CONCURRENCY",
    },
    providerBalanceAlertConcurrency: {
      doc: "Provider balance alert concurrency",
      format: "nat",
      default: 1,
      env: "PROVIDER_BALANCE_ALERT_CONCURRENCY",
    },
  },

  // Mobile Money Provider Limits
  providers: {
    mtn: {
      minAmount: {
        doc: "Minimum transaction amount for MTN (XAF)",
        format: "nat",
        default: 100,
        env: "MTN_MIN_AMOUNT",
      },
      maxAmount: {
        doc: "Maximum transaction amount for MTN (XAF)",
        format: "nat",
        default: 500000,
        env: "MTN_MAX_AMOUNT",
      },
      callbackSecret: {
        doc: "MTN callback HMAC secret for verifying incoming callbacks",
        format: String,
        default: "",
        env: "MTN_CALLBACK_SECRET",
      },
      callbackSignatureHeader: {
        doc: "Header used by MTN for callback signature verification",
        format: String,
        default: "X-Callback-Signature",
        env: "MTN_CALLBACK_SIGNATURE_HEADER",
      },
    },
    mtnUganda: {
      minAmount: {
        doc: "Minimum transaction amount for MTN Uganda (UGX)",
        format: "nat",
        default: 500,
        env: "MTN_UG_MIN_AMOUNT",
      },
      maxAmount: {
        doc: "Maximum transaction amount for MTN Uganda (UGX)",
        format: "nat",
        default: 5000000,
        env: "MTN_UG_MAX_AMOUNT",
      },
      baseUrl: {
        doc: "Base URL for MTN Uganda MoMo API",
        format: String,
        default: "https://sandbox.momodeveloper.mtn.com",
        env: "MTN_UG_BASE_URL",
      },
      environment: {
        doc: "MTN Uganda API Environment (sandbox or mtnuganda)",
        format: String,
        default: "sandbox",
        env: "MTN_UG_ENVIRONMENT",
      },
      subscriptionKey: {
        doc: "Subscription key for the MTN Uganda Disbursement API",
        format: String,
        default: "",
        env: "MTN_UG_DISBURSEMENT_SUB_KEY",
      },
      apiUser: {
        doc: "UUID generated for MTN Uganda API User",
        format: String,
        default: "",
        env: "MTN_UG_API_USER",
      },
      apiKey: {
        doc: "API Key generated during MTN Uganda provisioning",
        format: String,
        default: "",
        env: "MTN_UG_API_KEY",
      },
      currency: {
        doc: "Currency code for MTN Uganda",
        format: String,
        default: "UGX",
        env: "MTN_UG_CURRENCY",
      },
    },
    moovCoteDivoire: {
      minAmount: {
        doc: "Minimum transaction amount for Moov Côte d'Ivoire (XOF)",
        format: "nat",
        default: 100,
        env: "MOOV_CI_MIN_AMOUNT",
      },
      maxAmount: {
        doc: "Maximum transaction amount for Moov Côte d'Ivoire (XOF)",
        format: "nat",
        default: 1000000,
        env: "MOOV_CI_MAX_AMOUNT",
      },
      baseUrl: {
        doc: "Base URL for the Moov Côte d'Ivoire API",
        format: String,
        default: "",
        env: "MOOV_CI_BASE_URL",
      },
      authPath: {
        doc: "Path for acquiring a Moov Côte d'Ivoire access token",
        format: String,
        default: "/oauth/token",
        env: "MOOV_CI_AUTH_PATH",
      },
      depositPushPath: {
        doc: "Path for triggering a Moov Côte d'Ivoire deposit push",
        format: String,
        default: "/api/v1/deposit",
        env: "MOOV_CI_DEPOSIT_PUSH_PATH",
      },
      clientId: {
        doc: "Client ID for Moov Côte d'Ivoire API",
        format: String,
        default: "",
        env: "MOOV_CI_CLIENT_ID",
      },
      clientSecret: {
        doc: "Client Secret for Moov Côte d'Ivoire API",
        format: String,
        default: "",
        env: "MOOV_CI_CLIENT_SECRET",
      },
    },
    orangeCameroon: {
      minAmount: {
        doc: "Minimum transaction amount for Orange Cameroon (XAF)",
        format: "nat",
        default: 100,
        env: "ORANGE_CM_MIN_AMOUNT",
      },
      maxAmount: {
        doc: "Maximum transaction amount for Orange Cameroon (XAF)",
        format: "nat",
        default: 500000,
        env: "ORANGE_CM_MAX_AMOUNT",
      },
      baseUrl: {
        doc: "Base URL for Orange Cameroon API",
        format: String,
        default: "",
        env: "ORANGE_CM_BASE_URL",
      },
      merchantKey: {
        doc: "Merchant key for Orange Cameroon",
        format: String,
        default: "",
        env: "ORANGE_CM_MERCHANT_KEY",
      },
      authUrl: {
        doc: "Authentication URL for Orange Cameroon",
        format: String,
        default: "",
        env: "ORANGE_CM_AUTH_URL",
      },
    },
    airtelTanzania: {
      minAmount: {
        doc: "Minimum transaction amount for Airtel Tanzania (TZS)",
        format: "nat",
        default: 500,
        env: "AIRTEL_TZ_MIN_AMOUNT",
      },
      maxAmount: {
        doc: "Maximum transaction amount for Airtel Tanzania (TZS)",
        format: "nat",
        default: 3000000,
        env: "AIRTEL_TZ_MAX_AMOUNT",
      },
      baseUrl: {
        doc: "Base URL for Airtel Tanzania API",
        format: String,
        default: "",
        env: "AIRTEL_TZ_BASE_URL",
      },
      clientId: {
        doc: "Client ID for Airtel Tanzania",
        format: String,
        default: "",
        env: "AIRTEL_TZ_CLIENT_ID",
      },
      clientSecret: {
        doc: "Client Secret for Airtel Tanzania",
        format: String,
        default: "",
        env: "AIRTEL_TZ_CLIENT_SECRET",
      },
    },
    waveSenegal: {
      minAmount: {
        doc: "Minimum transaction amount for Wave Senegal (XOF)",
        format: "nat",
        default: 100,
        env: "WAVE_SN_MIN_AMOUNT",
      },
      maxAmount: {
        doc: "Maximum transaction amount for Wave Senegal (XOF)",
        format: "nat",
        default: 2000000,
        env: "WAVE_SN_MAX_AMOUNT",
      },
      baseUrl: {
        doc: "Base URL for Wave Senegal API",
        format: String,
        default: "https://api.wave.com/v1",
        env: "WAVE_SN_BASE_URL",
      },
      apiKey: {
        doc: "API Key for Wave Senegal",
        format: String,
        default: "",
        env: "WAVE_SN_API_KEY",
      },
    },
  },
});

// Load environment-specific configuration files if present
const envName = process.env.NODE_ENV || "development";
const configDir = path.join(__dirname, "configurations");
const envFilePath = path.join(configDir, `${envName}.json`);

if (fs.existsSync(envFilePath)) {
  configSchema.loadFile(envFilePath);
}

configSchema.validate({ allowed: "strict" });

export const appConfig = configSchema.get();

export function getConfig() {
  return configSchema.get();
}

export function getConfigValue<T>(key: string): T {
  return configSchema.get(key) as T;
}

export function loadConfigFiles(env?: string): void {
  const envName = env || process.env.NODE_ENV || "development";
  const configDir = path.join(__dirname, "configurations");
  const envFilePath = path.join(configDir, `${envName}.json`);
  if (fs.existsSync(envFilePath)) {
    configSchema.loadFile(envFilePath);
  }
}

export function validateConfig(): void {
  configSchema.validate({ allowed: "strict" });
}
