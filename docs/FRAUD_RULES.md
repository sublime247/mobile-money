# Fraud Detection Rules

This document outlines the fraud detection rules implemented in the mobile money system.

## Overview

The fraud detection system analyzes transactions in real-time to identify suspicious activity. It uses a scoring system where different types of anomalies contribute points to a fraud score. If the score exceeds a configurable threshold, the transaction is flagged for manual review.

## Configuration

Fraud detection rules are configurable via environment variables:

- `FRAUD_MAX_TRANSACTIONS_PER_HOUR`: Maximum transactions allowed per hour (default: 5)
- `FRAUD_AMOUNT_MULTIPLIER`: Multiplier for amount anomaly detection (default: 10)
- `FRAUD_MAX_DISTANCE_KM`: Maximum distance for location changes in km (default: 1000)
- `FRAUD_TIME_WINDOW_MS`: Time window for analysis in milliseconds (default: 3600000 = 1 hour)
- `FRAUD_SCORE_THRESHOLD`: Minimum score to flag as fraud (default: 50)
- `FRAUD_VELOCITY_SCORE`: Points for velocity violations (default: 30)
- `FRAUD_AMOUNT_SCORE`: Points for amount anomalies (default: 30)
- `FRAUD_GEO_SCORE`: Points for geographic anomalies (default: 25)
- `FRAUD_PATTERN_SCORE`: Points for failed attempt patterns (default: 15)

## Detection Rules

### 1. Velocity Check

- **Description**: Detects rapid transaction sequences that may indicate automated attacks
- **Condition**: More than `maxTransactionsPerHour` transactions within `timeWindowMs`
- **Score**: `velocityScore` points
- **Example**: 6+ transactions in 1 hour

### 2. Amount Anomaly

- **Description**: Identifies unusually large transactions compared to user history
- **Condition**: Transaction amount > `amountMultiplier` × recent average transaction amount
- **Score**: `amountScore` points
- **Example**: $1000 transaction when average is $50

### 3. Geographic Anomaly

- **Description**: Flags transactions from locations far from recent activity
- **Condition**: Location change > `maxDistanceKm` within `timeWindowMs`
- **Score**: `geoScore` points
- **Example**: Transaction 1500km from last location within 1 hour

### 4. Pattern Detection

- **Description**: Identifies repeated failed attempts that may indicate brute force
- **Condition**: 3+ failed transactions within `timeWindowMs`
- **Score**: `patternScore` points
- **Example**: Multiple failed payments in short succession

## Scoring System

- Fraud score is calculated by summing points from all triggered rules
- Transaction is flagged if score ≥ `fraudScoreThreshold`
- Each rule provides detailed reasoning in alert logs

## Response Actions

When fraud is detected:

1. Transaction is logged with structured JSON alerts
2. Transaction is added to manual review queue
3. Metrics are updated for monitoring
4. System continues processing (non-blocking)

## Monitoring

Fraud detection metrics are available via Prometheus:

- `transaction_total{type="fraud_check", status="passed|flagged"}`
- `transaction_errors_total{type="fraud_detection", error_type="fraud_flagged"}`

## Usage

```typescript
import { fraudService } from "./services/fraud";

// In transaction processing
const result = fraudService.processTransaction(transaction, userHistory);
if (result.isFraud) {
  // Handle flagged transaction
}
```

## Testing

Comprehensive unit tests cover all detection rules and edge cases. Run tests with:

```bash
npm test tests/services/fraud.test.ts
```

## Future Enhancements

- Machine learning-based scoring
- User risk profiling
- IP address analysis
- Device fingerprinting
- Integration with external fraud databases</content>
  <parameter name="filePath">c:\Users\HP\Desktop\drips\mobile-money\docs/FRAUD_RULES.md
