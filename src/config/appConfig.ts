import convict from "convict";
import * as path from "path";
import * as fs from "fs";

/**
 * Centralized application configuration using Convict.
 * This system consolidates all hardcoded limits, provider configs, and app settings
 * into a single source of truth with environment-based overrides.
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
    airtel: {
      minAmount: {
        doc: "Minimum transaction amount for Airtel (XAF)",
        format: "nat",
        default: 100,
        env: "AIRTEL_MIN_AMOUNT",
      },
      maxAmount: {
        doc: "Maximum transaction amount for Airtel (XAF)",
        format: "nat",
        default: 1000000,
        env: "AIRTEL_MAX_AMOUNT",
      },
      webBaseUrl: {
        doc: "Airtel web base URL (session mode)",
        format: String,
        default: "",
        env: "AIRTEL_WEB_BASE_URL",
      },
      directBaseUrl: {
        doc: "Airtel direct base URL (OAuth2 mode)",
        format: String,
        default: "https://openapi.airtel.africa",
        env: "AIRTEL_DIRECT_BASE_URL",
      },
      sandboxBaseUrl: {
        doc: "Airtel sandbox base URL (for sandbox mode)",
        format: String,
        default: "https://sandbox.airtel.africa",
        env: "AIRTEL_SANDBOX_BASE_URL",
      },
    },
    orange: {
      minAmount: {
        doc: "Minimum transaction amount for Orange (XAF)",
        format: "nat",
        default: 500,
        env: "ORANGE_MIN_AMOUNT",
      },
      maxAmount: {
        doc: "Maximum transaction amount for Orange (XAF)",
        format: "nat",
        default: 750000,
        env: "ORANGE_MAX_AMOUNT",
      },
    },
    orangeMadagascar: {
      minAmount: {
        doc: "Minimum transaction amount for Orange Madagascar (MGA)",
        format: "nat",
        default: 100,
        env: "ORANGE_MADAGASCAR_MIN_AMOUNT",
      },
      maxAmount: {
        doc: "Maximum transaction amount for Orange Madagascar (MGA)",
        format: "nat",
        default: 5000000,
        env: "ORANGE_MADAGASCAR_MAX_AMOUNT",
      },
      callbackSecret: {
        doc: "Orange Madagascar callback HMAC secret for verifying incoming callbacks",
        format: String,
        default: "",
        env: "ORANGE_MADAGASCAR_CALLBACK_SECRET",
      },
      callbackSignatureHeader: {
        doc: "Header used by Orange Madagascar for callback signature verification",
        format: String,
        default: "X-Callback-Signature",
        env: "ORANGE_MADAGASCAR_CALLBACK_SIGNATURE_HEADER",
      },
    },
    smsPortal: {
      minAmount: {
        doc: "Minimum transaction amount for SMS Portal (various currencies)",
        format: "nat",
        default: 100,
        env: "SMS_PORTAL_MIN_AMOUNT",
      },
      maxAmount: {
        doc: "Maximum transaction amount for SMS Portal (various currencies)",
        format: "nat",
        default: 5000000,
        env: "SMS_PORTAL_MAX_AMOUNT",
      },
    },
  },

  // Transaction Limits by KYC Level
  transactionLimits: {
    unverified: {
      doc: "Daily transaction limit for unverified users (XAF)",
      format: "nat",
      default: 10000,
      env: "LIMIT_UNVERIFIED",
    },
    basic: {
      doc: "Daily transaction limit for basic KYC users (XAF)",
      format: "nat",
      default: 100000,
      env: "LIMIT_BASIC",
    },
    full: {
      doc: "Daily transaction limit for full KYC users (XAF)",
      format: "nat",
      default: 1000000,
      env: "LIMIT_FULL",
    },
  },

  // General Transaction Limits
  transactions: {
    minAmount: {
      doc: "Minimum transaction amount (XAF)",
      format: "nat",
      default: 100,
      env: "MIN_TRANSACTION_AMOUNT",
    },
    maxAmount: {
      doc: "Maximum transaction amount (XAF)",
      format: "nat",
      default: 1000000,
      env: "MAX_TRANSACTION_AMOUNT",
    },
    maxTags: {
      doc: "Maximum number of tags per transaction",
      format: "nat",
      default: 10,
    },
    maxMetadataBytes: {
      doc: "Maximum size of transaction metadata in bytes",
      format: "nat",
      default: 10240, // 10 KB
    },
    maxNotesLength: {
      doc: "Maximum length of transaction notes",
      format: "nat",
      default: 256,
    },
    timeoutMinutes: {
      doc: "Transaction timeout in minutes",
      format: "nat",
      default: 30,
      env: "TRANSACTION_TIMEOUT_MINUTES",
    },
    idempotencyKeyTtlHours: {
      doc: "TTL for idempotency keys in hours",
      format: "nat",
      default: 24,
      env: "IDEMPOTENCY_KEY_TTL_HOURS",
    },
  },

  // Authentication
  auth: {
    maxLoginAttempts: {
      doc: "Maximum login attempts before lockout",
      format: "nat",
      default: 5,
      env: "MAX_LOGIN_ATTEMPTS",
    },
    webauthnChallengeTtlSeconds: {
      doc: "WebAuthn challenge TTL in seconds",
      format: "nat",
      default: 300,
    },
    adminApiKey: {
      doc: "Admin API key for development/testing",
      format: String,
      default: "dev-admin-key",
      env: "ADMIN_API_KEY",
    },
  },

  // Cache and TTL Settings
  cache: {
    geolocationTtlSeconds: {
      doc: "Geolocation cache TTL in seconds",
      format: "nat",
      default: 86400, // 24 hours
    },
    geolocationApiTimeoutMs: {
      doc: "Geolocation API timeout in milliseconds",
      format: "nat",
      default: 3000,
    },
    healthCheckCacheTtlSeconds: {
      doc: "Health check cache TTL in seconds",
      format: "nat",
      default: 300, // 5 minutes
    },
    volumeCacheTtlSeconds: {
      doc: "Volume cache TTL in seconds",
      format: "nat",
      default: 300, // 5 minutes
    },
    feeStrategyTtlSeconds: {
      doc: "Fee strategy cache TTL in seconds",
      format: "nat",
      default: 60,
    },
    loadBalancerHealthCacheTtlMs: {
      doc: "Load balancer health check cache TTL in milliseconds",
      format: "nat",
      default: 5000,
    },
    acceptLanguageCacheLimit: {
      doc: "Accept-Language header cache limit",
      format: "nat",
      default: 250,
    },
    slowQueryThresholdMs: {
      doc: "Slow query logging threshold in milliseconds",
      format: "nat",
      default: 1000,
      env: "SLOW_QUERY_THRESHOLD_MS",
    },
  },

  // Mobile Money Provider Health Checks
  healthCheck: {
    failureThreshold: {
      doc: "Number of consecutive failures before opening the health-check circuit breaker",
      format: "nat",
      default: 3,
      env: "PROVIDER_HEALTH_FAILURE_THRESHOLD",
    },
    openDurationMs: {
      doc: "Duration (ms) to keep the health-check circuit breaker open before allowing a retry",
      format: "nat",
      default: 60000, // 1 minute
      env: "PROVIDER_HEALTH_OPEN_DURATION_MS",
    },
  },

  // Orange Provider Settings
  orange: {
    defaultSessionTtlMs: {
      doc: "Orange session TTL in milliseconds",
      format: "nat",
      default: 1200000, // 20 minutes
    },
    defaultRefreshSkewMs: {
      doc: "Orange refresh token skew in milliseconds",
      format: "nat",
      default: 60000, // 1 minute
    },
    requestTimeoutMs: {
      doc: 'Orange API request timeout in milliseconds',
      format: 'nat',
      default: 30000,
      env: 'ORANGE_REQUEST_TIMEOUT_MS',
    },
  },

  // SEP-38 (Rate Provider)
  sep38: {
    pricePrecision: {
      doc: "Price precision for SEP-38 rates",
      format: "nat",
      default: 7,
    },
    xlmUsdFallback: {
      doc: "Fallback XLM/USD rate",
      format: Number,
      default: 0.12,
    },
  },

  // File Upload
  fileUpload: {
    maxDisputeFileSize: {
      doc: "Maximum dispute file size in bytes",
      format: "nat",
      default: 10485760, // 10 MB
    },
  },

  // Liquidity Management
  liquidity: {
    transferTargetRatio: {
      doc: "Target ratio for liquidity rebalancing",
      format: Number,
      default: 0.5, // 50%
    },
  },

  // Encryption
  encryption: {
    ivLength: {
      doc: "IV length for AES-GCM encryption in bytes",
      format: "nat",
      default: 12, // 96-bit
    },
    authTagLength: {
      doc: "Auth tag length for AES-GCM encryption in bytes",
      format: "nat",
      default: 16, // 128-bit
    },
  },

  // Stellar
  stellar: {
    stroopsPerXlm: {
      doc: "Number of stroops per XLM",
      format: "nat",
      default: 10000000,
    },
  },

  // Mobile Money Rate Limiting
  mobileMoney: {
    rateLimitWindowMs: {
      doc: "Rate limiting window in milliseconds",
      format: "nat",
      default: 3600000, // 1 hour
    },
    rateLimitThreshold: {
      doc: "Rate limiting threshold (number of requests)",
      format: "nat",
      default: 3,
    },
  },

  // Slow Query Logging
  logging: {
    enableSlowQueryLogging: {
      doc: "Enable slow query logging",
      format: Boolean,
      default: false,
      env: "ENABLE_SLOW_QUERY_LOGGING",
    },
  },

  // Response compression
  compression: {
    enabled: {
      doc: 'Enable HTTP response compression',
      format: Boolean,
      default: true,
      env: 'COMPRESSION_ENABLED',
    },
    threshold: {
      doc: 'Minimum response size in bytes to trigger compression',
      format: 'nat',
      default: 1024,
      env: 'COMPRESSION_THRESHOLD',
    },
    level: {
      doc: 'Gzip compression level (0-9) used by zlib',
      format: 'nat',
      default: 6,
      env: 'COMPRESSION_LEVEL',
    },
  },
});

/**
 * Load configuration from files if they exist
 */
export function loadConfigFiles(env: string): void {
  const configDir = path.join(__dirname, "configurations");

  // Load environment-specific config
  const envConfigPath = path.join(configDir, `${env}.json`);
  if (fs.existsSync(envConfigPath)) {
    configSchema.loadFile(envConfigPath);
  }

  // Load local overrides if they exist (for development)
  const localConfigPath = path.join(configDir, "local.json");
  if (fs.existsSync(localConfigPath)) {
    configSchema.loadFile(localConfigPath);
  }
}

/**
 * Validate the configuration
 */
export function validateConfig(): void {
  configSchema.validate({ allowed: "strict" });
}

/**
 * Get the configuration
 */
export function getConfig() {
  return configSchema.getProperties();
}

/**
 * Get a specific configuration value
 */
export function getConfigValue(key: string): any {
  return configSchema.get(key);
}

export default configSchema;
