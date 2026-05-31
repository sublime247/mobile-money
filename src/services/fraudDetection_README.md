# Fraud Detection Scoring Engine

## Overview

This comprehensive fraud detection system implements 12+ heuristics to identify suspicious transactions and automatically flag high-risk activities for review. The system assigns fraud scores to each transaction and can automatically set suspicious transactions to 'Review' status.

## Features

### 🎯 12+ Fraud Detection Heuristics

1. **Velocity Check** - Monitors transaction frequency per hour/minute
2. **Amount Anomaly** - Detects unusually large transactions compared to user average
3. **Geographic Anomaly** - Flags suspicious location changes
4. **Pattern Detection** - Identifies multiple failed transaction attempts
5. **High-Risk Phone Numbers** - Matches against known fraud numbers
6. **IP Geolocation Mismatch** - Compares IP location with transaction location
7. **Unusual Transaction Hours** - Flags transactions during odd hours
8. **Device Fingerprint Anomaly** - Detects new or suspicious devices
9. **Account Age Risk** - Identifies high-value transactions from new accounts
10. **KYC Level Risk** - Flags high-value transactions from low KYC users
11. **Transaction Frequency Spike** - Detects sudden increases in transaction frequency
12. **Custom Heuristics** - Extensible framework for additional rules

### 🔧 Key Components

- **FraudService** - Core fraud detection engine
- **FraudDetectionMiddleware** - Express.js middleware integration
- **TransactionStatus.Review** - New status for flagged transactions
- **Redis Caching** - High-risk numbers and device fingerprint storage
- **Metrics Integration** - Prometheus metrics for monitoring

## Installation & Setup

### Environment Variables

```bash
# Fraud Detection Configuration
FRAUD_MAX_TRANSACTIONS_PER_HOUR=5
FRAUD_MAX_TRANSACTIONS_PER_MINUTE=2
FRAUD_AMOUNT_MULTIPLIER=10
FRAUD_MAX_DISTANCE_KM=1000
FRAUD_TIME_WINDOW_MS=3600000
FRAUD_SHORT_TIME_WINDOW_MS=300000
FRAUD_SCORE_THRESHOLD=50
FRAUD_HIGH_VALUE_THRESHOLD=1000
FRAUD_NEW_ACCOUNT_DAYS=7

# Scoring Weights
FRAUD_VELOCITY_SCORE=25
FRAUD_AMOUNT_SCORE=20
FRAUD_GEO_SCORE=20
FRAUD_PATTERN_SCORE=15
FRAUD_HIGH_RISK_NUMBER_SCORE=30
FRAUD_IP_MISMATCH_SCORE=25
FRAUD_UNUSUAL_HOURS_SCORE=10
FRAUD_DEVICE_ANOMALY_SCORE=15
FRAUD_NEW_ACCOUNT_SCORE=20
FRAUD_KYC_RISK_SCORE=15
FRAUD_FREQUENCY_SPIKE_SCORE=15

# Time-based Rules
FRAUD_UNUSUAL_HOURS_START=23
FRAUD_UNUSUAL_HOURS_END=5
FRAUD_DEVICE_FINGERPRINT_WINDOW_MS=86400000
```

### Database Schema

The system uses the existing `transactions` table with the new `Review` status:

```sql
ALTER TYPE transaction_status ADD VALUE 'review';
```

## Usage

### Basic Fraud Detection

```typescript
import { fraudService, FraudTransactionInput } from "./services/fraud";

const transactionInput: FraudTransactionInput = {
  id: "txn_123",
  userId: "user_456",
  amount: 1500,
  phoneNumber: "+1234567890",
  timestamp: new Date(),
  location: { lat: 40.7128, lng: -74.006 },
  ipAddress: "192.168.1.1",
  userAgent: "Mozilla/5.0...",
  deviceFingerprint: "abc123",
  type: "deposit",
  provider: "mtn",
};

const result = await fraudService.processTransaction(transactionInput);

if (result.isFraud) {
  console.log("Fraud detected:", {
    score: result.score,
    riskLevel: result.riskLevel,
    reasons: result.reasons,
    action: result.recommendedAction,
  });
}
```

### Express.js Middleware Integration

```typescript
import { fraudDetectionMiddleware } from "./middleware/fraudDetection";

// Apply to transaction routes
app.post(
  "/api/transactions",
  fraudDetectionMiddleware.detectFraud,
  transactionController.create,
);

// Check fraud results in controller
router.post("/transactions", async (req, res) => {
  const fraudResult = (req as any).fraudResult;

  if (fraudResult?.isFraud) {
    // Handle flagged transaction
    return res.status(202).json({
      message: "Transaction under review",
      fraudAnalysis: fraudResult,
    });
  }

  // Normal processing
  // ...
});
```

### Review Queue Management

```typescript
// Get transactions requiring review
const reviewQueue = fraudService.getReviewQueue();

// Process a reviewed transaction
await fraudService.setTransactionToReview("txn_123");

// Clear review queue after processing
fraudService.clearReviewQueue();
```

## Risk Levels & Actions

### Score Thresholds

- **0-39**: Low Risk → `allow`
- **40-59**: Medium Risk → `allow` with monitoring
- **60-79**: High Risk → `review`
- **80+**: Critical Risk → `block`

### Risk Levels

| Level    | Score Range | Action | Description                   |
| -------- | ----------- | ------ | ----------------------------- |
| Low      | 0-39        | Allow  | Normal transaction processing |
| Medium   | 40-59       | Allow  | Monitor for patterns          |
| High     | 60-79       | Review | Manual review required        |
| Critical | 80+         | Block  | Transaction blocked           |

## API Endpoints

### Transaction Management

```typescript
// Create transaction with fraud detection
POST /api/transactions
{
  "amount": 1000,
  "phoneNumber": "+1234567890",
  "type": "deposit",
  "provider": "mtn"
}

// Get transactions with fraud analysis
GET /api/transactions?status=review

// Get fraud statistics
GET /api/fraud/statistics
```

### Review Queue Management

```typescript
// Get review queue
GET /api/fraud/review-queue

// Process reviewed transaction
POST /api/fraud/review-queue/:transactionId/process
{
  "action": "approve|reject|block",
  "notes": "Review notes"
}
```

## Monitoring & Metrics

### Prometheus Metrics

```typescript
// Fraud detection metrics
transaction_total{type="fraud_check",status="flagged|passed"}
transaction_errors_total{type="fraud_detection",error_type="fraud_flagged"}
```

### Logging

```typescript
// Fraud alerts are logged as structured JSON
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "WARN",
  "type": "FRAUD_ALERT",
  "transactionId": "txn_123",
  "userId": "user_456",
  "score": 75,
  "riskLevel": "high",
  "reasons": ["High-value transaction from new account"],
  "heuristicsTriggered": ["new_account_risk"]
}
```

## Configuration

### Custom Heuristics

```typescript
// Extend the fraud service with custom rules
class CustomFraudService extends FraudService {
  async detectFraud(
    transactionInput: FraudTransactionInput,
  ): Promise<FraudResult> {
    const baseResult = await super.detectFraud(transactionInput);

    // Add custom logic
    if (this.isCustomRule(transactionInput)) {
      baseResult.score += 10;
      baseResult.reasons.push("Custom rule triggered");
    }

    return baseResult;
  }

  private isCustomRule(input: FraudTransactionInput): boolean {
    // Custom rule implementation
    return false;
  }
}
```

### High-Risk Number Management

```typescript
// Update high-risk numbers list
await redisClient.setex(
  "fraud:high_risk_numbers",
  3600,
  JSON.stringify(["+1234567890", "+0987654321", "+5555555555"]),
);
```

## Performance Considerations

### Redis Caching

- High-risk numbers cached for 1 hour
- Device fingerprints cached for 24 hours
- User transaction history fetched from database

### Database Optimization

- Index on `user_id` and `created_at` for transaction queries
- Consider materialized views for fraud statistics
- Implement connection pooling for high volume

### Async Processing

- Fraud detection runs asynchronously
- Non-blocking middleware implementation
- Graceful degradation on service failures

## Security Considerations

### Data Protection

- Phone numbers encrypted in database
- IP addresses handled according to privacy policy
- Device fingerprints hashed for security

### Rate Limiting

- Implement rate limiting on fraud detection endpoints
- Prevent enumeration of high-risk numbers
- Monitor for abuse of review system

## Testing

### Unit Tests

```typescript
import { fraudService } from "./services/fraud";

describe("Fraud Detection", () => {
  test("should flag high-value transaction", async () => {
    const result = await fraudService.detectFraud({
      id: "test",
      amount: 5000,
      phoneNumber: "+1234567890",
      timestamp: new Date(),
      type: "deposit",
      provider: "test",
    });

    expect(result.isFraud).toBe(true);
    expect(result.score).toBeGreaterThan(50);
  });
});
```

### Integration Tests

```typescript
describe("Fraud Detection Middleware", () => {
  test("should block critical risk transactions", async () => {
    const response = await request(app)
      .post("/api/transactions")
      .send(suspiciousTransaction)
      .expect(403);

    expect(response.body.error).toContain("blocked due to fraud detection");
  });
});
```

## Troubleshooting

### Common Issues

1. **Redis Connection Failures**
   - Check Redis server status
   - Verify connection configuration
   - Implement fallback behavior

2. **High False Positive Rate**
   - Adjust score thresholds
   - Review heuristic weights
   - Add user-specific baselines

3. **Performance Issues**
   - Monitor database query performance
   - Optimize Redis operations
   - Consider async processing

### Debug Mode

```typescript
// Enable debug logging
process.env.DEBUG = "fraud:*";

// Get detailed fraud analysis
const result = await fraudService.detectFraud(transaction);
console.log("Fraud analysis:", result);
```

## Contributing

### Adding New Heuristics

1. Implement heuristic method in `FraudService`
2. Add configuration options
3. Update scoring weights
4. Add unit tests
5. Update documentation

### Code Style

- Follow TypeScript best practices
- Use async/await for database operations
- Implement proper error handling
- Add comprehensive logging

## License

This fraud detection system is part of the mobile money platform and follows the same licensing terms.
