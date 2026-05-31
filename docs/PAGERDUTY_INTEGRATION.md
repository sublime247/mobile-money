# PagerDuty Integration - Provider Error Rate Monitoring

## Overview

This integrates PagerDuty Events API V2 with the mobile-money platform to automatically alert on-call engineers when provider error rates exceed 15% in a 5-minute sliding window.

**Key Features:**

- ✅ Automatic CRITICAL incident creation when error rates spike
- ✅ Auto-resolution when error rates recover below threshold
- ✅ Sliding window calculations (5-minute windows)
- ✅ Per-provider error tracking
- ✅ Zero false positives - only alerts when necessary

## Architecture

### Components

```
┌──────────────────────────────────────────┐
│      Application Request Handling         │
└────────────────┬─────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────┐
│   Metrics Collection (Prometheus)         │
│  - transactionErrorsTotal Counter         │
│  - transactionTotal Counter               │
└────────────────┬─────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────┐
│    MonitoringService (30s checks)         │
│  - Collects metrics from Prometheus       │
│  - Calculates 5-min sliding window rates  │
│  - Compares against 15% threshold         │
└────────────────┬─────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────┐
│   PagerDutyService                        │
│  - Triggers CRITICAL incidents (>15%)     │
│  - Auto-resolves when rate < 15%          │
│  - Uses Events API V2 for updates         │
└────────────────┬─────────────────────────┘
                 │
                 ▼
     PagerDuty Events API V2
```

### Data Flow

1. **Error Recording**: Provider operations succeed/fail, metrics are recorded
2. **Collection**: MonitoringService polls Prometheus metrics every 30 seconds
3. **Calculation**: Error rate calculated within 5-minute sliding window
4. **Decision**: If error rate > 15%, trigger incident; if < 15%, resolve
5. **Notification**: PagerDuty incident created/resolved, on-call notified

## Setup Instructions

### 1. Configure PagerDuty Account

#### Create an Integration Key

1. Go to PagerDuty → Services → Your Service → Integrations
2. Click "Add Integration" and select "Use our API directly"
3. Select "Events API V2" as the integration type
4. Copy the generated **Integration Key** (Routing Key)

#### Example Integration Key Format

```
RxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxE
```

### 2. Environment Variables

Add to your `.env` file or deployment configuration:

```bash
# PagerDuty Configuration
PAGERDUTY_INTEGRATION_KEY=Rxxx...xxx  # Events API V2 Routing Key
PAGERDUTY_DEDUP_KEY=mobile-money      # Dedup prefix (optional, defaults to mobile-money)

# Other existing variables remain unchanged
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
```

### 3. Verify Integration

Check logs during startup:

```
PagerDuty monitoring service started
```

If the key is missing or invalid:

```
PagerDuty service is disabled
```

## Usage

### Automatic Operation

Once configured, the system works automatically:

```
Timeline:
00:00 - Provider API degradation begins (errors spike)
00:10 - Error rate reaches 16% (exceeds 15% threshold)
00:11 - PagerDuty CRITICAL incident triggered
00:12 - On-call engineer notified via PagerDuty
00:15 - Provider recovers, error rate drops to 12%
00:16 - PagerDuty incident auto-resolved
00:17 - On-call engineer sees incident resolved
```

### Recording Provider Operations

When handling provider operations, ensure metrics are tracked:

```typescript
import {
  recordProviderSuccess,
  recordProviderError,
} from "../middleware/providerMetrics";

try {
  const result = await callPaymentProvider("stripe", paymentData);
  recordProviderSuccess("stripe", "payment");
} catch (error) {
  recordProviderError("stripe", "payment", error.type || "unknown");
  throw error;
}
```

### Manual Monitoring

Query current error rates programmatically:

```typescript
import { MonitoringService } from "../services/monitoringService";

// Get all provider metrics
const metrics = MonitoringService.getProviderMetrics();

// Get specific provider
const stripeMetrics = MonitoringService.getProviderMetricsFor("stripe");
console.log(`Stripe error rate: ${(stripeMetrics?.errorRate ?? 0) * 100}%`);

// Check if alert would be triggered
if ((stripeMetrics?.errorRate ?? 0) > 0.15) {
  console.warn("Alert threshold would be triggered!");
}
```

## Thresholds & Timing

| Setting                | Value      | Rationale                                   |
| ---------------------- | ---------- | ------------------------------------------- |
| Error Rate Threshold   | 15%        | Balances sensitivity with false positives   |
| Time Window            | 5 minutes  | Captures provider degradation patterns      |
| Check Interval         | 30 seconds | Responsive alerts without excessive polling |
| Auto-Resolve Threshold | < 15%      | Same threshold in reverse                   |

## PagerDuty Incident Details

### Alert Payload Example

```json
{
  "routing_key": "Rxxx...",
  "event_action": "trigger",
  "dedup_key": "mobile-money-stripe-error-rate",
  "payload": {
    "summary": "[CRITICAL] Provider stripe error rate at 18.50% (threshold: 15%)",
    "timestamp": "2024-03-28T14:30:00.000Z",
    "severity": "critical",
    "source": "mobile-money-api",
    "custom_details": {
      "provider": "stripe",
      "errorRatePercentage": "18.50",
      "threshold": "15%",
      "window": "5 minutes",
      "environment": "production"
    }
  }
}
```

### Resolution Payload Example

```json
{
  "routing_key": "Rxxx...",
  "event_action": "resolve",
  "dedup_key": "mobile-money-stripe-error-rate",
  "payload": {
    "summary": "[RESOLVED] Provider stripe error rate recovered to 12.00%",
    "timestamp": "2024-03-28T14:35:00.000Z",
    "severity": "info",
    "source": "mobile-money-api",
    "custom_details": {
      "provider": "stripe",
      "errorRatePercentage": "12.00"
    }
  }
}
```

## Testing

### Unit Tests

```bash
npm run test -- pagerDutyService.test.ts
```

### Manual Testing with Debug

```typescript
// In development, temporarily enable console logging:
const service = new PagerDutyService({
  integrationKey: process.env.PAGERDUTY_INTEGRATION_KEY,
  dedupKey: "mobile-money",
  enabled: true, // Force enable for testing
});

service.start();
```

### Simulating Error Spikes (Development Only)

```typescript
// For local testing, artificially trigger errors:
const pagerDuty = createPagerDutyService();
for (let i = 0; i < 100; i++) {
  if (i % 6 === 0) {
    // 16% error rate (above threshold)
    pagerDuty.recordProviderError("test-provider", Date.now());
  } else {
    pagerDuty.recordProviderSuccess("test-provider");
  }
}
// Check if incident would be triggered...
```

## Troubleshooting

### "PagerDuty service is disabled"

**Cause**: Missing `PAGERDUTY_INTEGRATION_KEY` environment variable  
**Solution**: Set the integration key and restart the application

### Incidents not triggering

1. Verify `PAGERDUTY_INTEGRATION_KEY` is correct
2. Check error rate exceeds 15% threshold
3. Review PagerDuty integration service settings
4. Check application logs for API errors

### False positives (too many alerts)

**Issue**: Alerts above 15% might be normal for your service  
**Solution**: Adjust threshold in `PagerDutyService` (currently line 36)

```typescript
private static readonly ERROR_RATE_THRESHOLD = 0.15; // Change to 0.20 for 20%
```

### Incidents not auto-resolving

**Cause**: Error rate may be hovering around threshold  
**Solution**: Monitor the error rate trend in PagerDuty dashboard

## Metrics Schema

### Tracked Metrics

- `transaction_errors_total`: Counter tracking errors by provider
- `transaction_total`: Counter tracking all transactions by provider
- `provider_response_time_seconds`: Histogram of provider response times
- `provider_circuit_breaker_state`: Gauge for circuit breaker status

### Labels

```typescript
// Error tracking labels
{
  type: "payment" | "payout",
  provider: "stripe" | "square" | "flutterwave" | etc.,
  error_type: "timeout" | "rate_limit" | "invalid_account" | etc.
}
```

## Performance Considerations

- Monitoring checks run every 30 seconds (configurable)
- Memory usage: O(m) where m = number of monitored providers (typically < 10)
- PagerDuty API calls: 1-2 per provider per check cycle (only when threshold crossed)
- No database queries required

## Production Checklist

- [ ] Integration key configured and tested
- [ ] PagerDuty escalation policy configured
- [ ] On-call schedule active in PagerDuty
- [ ] Notification integrations enabled (email, SMS, Slack)
- [ ] Dashboard alerts created for monitoring
- [ ] Team trained on incident response
- [ ] Error threshold appropriate for your SLAs

## Advanced Configuration

### Custom Threshold

```typescript
// In MonitoringService.ts, line 21
private static readonly ERROR_RATE_THRESHOLD = 0.20; // 20% instead of 15%
```

### Custom Window Duration

```typescript
// In PagerDutyService.ts, line 37
private static readonly WINDOW_MS = 10 * 60 * 1000; // 10 minutes instead of 5
```

### Custom Check Interval

```typescript
// In index.ts, during initialization
MonitoringService.start(15000); // Check every 15 seconds instead of 30
```

## Related Documentation

- [PagerDuty Events API V2](https://developer.pagerduty.com/docs/events-api-v2/overview/)
- [Monitoring Architecture](../ARCHITECTURE.md)
- [Metrics Setup](./metrics.md)
- [Error Handling](../CODE_COVERAGE.md)

## Support

For issues or questions:

1. Check application logs for error messages
2. Verify PagerDuty integration key validity
3. Test with manual error rate simulation
4. Review PagerDuty incident history for details
