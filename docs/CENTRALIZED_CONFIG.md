# Centralized Configuration Management

This document describes the centralized configuration management system for the Mobile Money application.

## Overview

The application uses **Convict** for centralized configuration management. This replaces scattered hardcoded values with a single source of truth that supports environment-based overrides.

## Key Benefits

- ✅ **Single Source of Truth**: All configuration in one location
- ✅ **Type-Safe**: Schema validation ensures type safety
- ✅ **Environment-Based**: Easy per-environment configuration
- ✅ **Low Logic Changes**: Minimal changes to existing code
- ✅ **Easy Overrides**: Environment variables take precedence
- ✅ **Documented**: All config options have descriptions

## Configuration Schema

The main schema is defined in `src/config/appConfig.ts`. It includes:

### Provider Limits

```
providers:
  - mtn: { minAmount, maxAmount }
  - airtel: { minAmount, maxAmount }
  - orange: { minAmount, maxAmount }
```

### Transaction Limits (by KYC Level)

```
transactionLimits:
  - unverified: daily limit
  - basic: daily limit
  - full: daily limit
```

### General Transaction Settings

```
transactions:
  - minAmount: global minimum
  - maxAmount: global maximum
  - maxTags: max tags per transaction
  - maxMetadataBytes: max metadata size
  - maxNotesLength: max notes length
  - timeoutMinutes: transaction timeout
  - idempotencyKeyTtlHours: idempotency key TTL
```

### Authentication Settings

```
auth:
  - maxLoginAttempts: failed login limit
  - webauthnChallengeTtlSeconds: WebAuthn challenge TTL
  - adminApiKey: admin API key
```

### Cache Settings

```
cache:
  - geolocationTtlSeconds
  - geolocationApiTimeoutMs
  - healthCheckCacheTtlSeconds
  - volumeCacheTtlSeconds
  - feeStrategyTtlSeconds
  - loadBalancerHealthCacheTtlMs
  - acceptLanguageCacheLimit
  - slowQueryThresholdMs
```

## Configuration Files

Configuration files are stored in `src/config/configurations/`:

- **development.json**: Development environment defaults
- **staging.json**: Staging environment defaults
- **production.json**: Production environment defaults
- **local.json** (optional): Local overrides for development

## Using Configuration

### Import the config module

```typescript
import { getConfigValue, getConfig } from "src/config";

// Get a single value
const maxAmount = getConfigValue("providers.mtn.maxAmount");

// Get all configuration
const config = getConfig();

// Use helper functions
import {
  getTransactionConfig,
  getCacheConfig,
  getAuthConfig,
} from "src/config";

const txConfig = getTransactionConfig();
console.log(txConfig.timeoutMinutes);
```

### In Service Classes

```typescript
import { getConfigValue } from "src/config";

class TransactionService {
  validateAmount(provider: string, amount: number) {
    const limits = getConfigValue(`providers.${provider}`);
    if (amount < limits.minAmount) {
      // error
    }
  }
}
```

## Environment Variable Overrides

All configuration values can be overridden via environment variables:

```bash
# Provider limits
export MTN_MIN_AMOUNT=250
export MTN_MAX_AMOUNT=1000000
export AIRTEL_MIN_AMOUNT=200

# Transaction limits
export LIMIT_UNVERIFIED=50000
export LIMIT_BASIC=200000
export LIMIT_FULL=2000000

# Transaction settings
export MIN_TRANSACTION_AMOUNT=500
export MAX_TRANSACTION_AMOUNT=5000000
export TRANSACTION_TIMEOUT_MINUTES=45

# Authentication
export MAX_LOGIN_ATTEMPTS=10

# Caching
export SLOW_QUERY_THRESHOLD_MS=2000
```

### Chaos Provider Controls

The staging chaos provider reads its simulation settings directly from `process.env`
when `ChaosMiddleware` is constructed without an explicit config. Tests may also
pass an explicit `ChaosConfig` object to override these values for a single run.

| Variable               | Default | Description                                                                          |
| ---------------------- | ------: | ------------------------------------------------------------------------------------ |
| `CHAOS_ENABLED`        | `false` | Enables latency and failure injection when set to `true`, `1`, `yes`, or `on`.       |
| `CHAOS_LATENCY_CHANCE` |     `0` | Ratio from `0` to `1` for adding latency to an operation.                            |
| `CHAOS_LATENCY_MIN_MS` |     `0` | Lower latency bound in milliseconds.                                                 |
| `CHAOS_LATENCY_MAX_MS` |     `0` | Upper latency bound in milliseconds.                                                 |
| `CHAOS_LATENCY_MS`     |     `0` | Backward-compatible alias for `CHAOS_LATENCY_MAX_MS` when the max variable is unset. |
| `CHAOS_ERROR_CHANCE`   |     `0` | Ratio from `0` to `1` for returning a simulated provider 500 response.               |
| `CHAOS_DROP_CHANCE`    |     `0` | Ratio from `0` to `1` for throwing a simulated connection reset.                     |

Examples:

```bash
# Disable chaos entirely
CHAOS_ENABLED=false pnpm test tests/services/mobilemoney/chaos.test.ts

# Add 100-750ms latency to every provider call, without injected failures
CHAOS_ENABLED=true \
CHAOS_LATENCY_CHANCE=1 \
CHAOS_LATENCY_MIN_MS=100 \
CHAOS_LATENCY_MAX_MS=750 \
CHAOS_ERROR_CHANCE=0 \
CHAOS_DROP_CHANCE=0 \
pnpm test tests/services/mobilemoney/chaos.test.ts

# Run a mixed staging scenario with latency, provider 500s, and drops
CHAOS_ENABLED=true \
CHAOS_LATENCY_CHANCE=0.4 \
CHAOS_LATENCY_MIN_MS=50 \
CHAOS_LATENCY_MAX_MS=500 \
CHAOS_ERROR_CHANCE=0.05 \
CHAOS_DROP_CHANCE=0.02 \
pnpm test
```

## Migration Guide

### For Existing Code

Old approach (hardcoded):

```typescript
const MIN_AMOUNT = 100;
const MAX_AMOUNT = 500000;

if (amount < MIN_AMOUNT) {
  // error
}
```

New approach (config):

```typescript
import { getConfigValue } from "src/config";

const minAmount = getConfigValue("transactions.minAmount");
const maxAmount = getConfigValue("transactions.maxAmount");

if (amount < minAmount) {
  // error
}
```

### Fetching Provider Limits

Old approach:

```typescript
import { PROVIDER_LIMITS } from "src/config/providers";
const limits = PROVIDER_LIMITS["mtn"];
```

New approach (still works!):

```typescript
// Direct import still works due to migration
import { PROVIDER_LIMITS } from "src/config/providers";
const limits = PROVIDER_LIMITS["mtn"];

// Or use helper
import { getProviderLimit } from "src/config";
const limits = getProviderLimit("mtn");
```

## Configuration Precedence

1. **Environment Variables** (highest priority)
   - Set via `process.env.VARIABLE_NAME`
   - Examples: `MTN_MIN_AMOUNT=250`, `LIMIT_FULL=2000000`

2. **Local Configuration** (`src/config/configurations/local.json`)
   - Development-only overrides
   - Gitignored for security

3. **Environment-Specific Configuration**
   - `development.json`, `staging.json`, `production.json`
   - Based on `NODE_ENV` value

4. **Schema Defaults** (lowest priority)
   - Built-in defaults in `appConfig.ts`

## Adding New Configuration

1. **Add to Schema** in `src/config/appConfig.ts`:

```typescript
export const configSchema = convict({
  myNewSetting: {
    doc: "Description of the setting",
    format: String, // or 'nat', Number, Boolean, etc.
    default: "default-value",
    env: "MY_NEW_SETTING", // optional env var name
  },
});
```

2. **Add to Environment Files**:

```json
// src/config/configurations/development.json
{
  "myNewSetting": "dev-value"
}
```

3. **Use in Code**:

```typescript
import { getConfigValue } from "src/config";
const setting = getConfigValue("myNewSetting");
```

## Best Practices

✅ **DO:**

- Use config for all limits, TTLs, and thresholds
- Document all configuration options
- Use environment variables in production
- Keep defaults sensible
- Use typed helper functions

❌ **DON'T:**

- Hardcode magic numbers
- Use `process.env.MY_VAR` directly (use `getConfigValue` instead)
- Store sensitive data in JSON files (use env vars instead)
- Modify config during runtime (it's immutable after initialization)

## Testing

Run configuration tests:

```bash
npm test -- src/config/__tests__/appConfig.test.ts
```

Validate configuration at startup:

```bash
npm run build && npm start
```

## Troubleshooting

### Configuration not loading

- Check that `NODE_ENV` is set correctly
- Verify JSON files are in `src/config/configurations/`
- Check for JSON syntax errors

### Environment variable not working

- Ensure variable name matches the schema
- Check that convict's env property is set
- Note: Changes require app restart

### Circular dependency issues

- Import config init early: `import 'src/config/init'`
- Use lazy imports if needed: `const { getConfigValue } = require('src/config')`

## Future Enhancements

- [ ] Remote configuration support (e.g., AWS AppConfig)
- [ ] Hot-reload capability for non-critical config
- [ ] Configuration audit logging
- [ ] Automated config documentation generation
