# Periodic Fee Bumping for Stuck Stellar Transactions

## Overview

This implementation provides automatic fee bumping for Stellar transactions that haven't cleared within 30 seconds, ensuring no transactions remain stuck in high-traffic periods.

## Features Implemented

### ✅ Transaction Monitoring
- **Pending Transaction Tracking**: Monitors all pending Stellar transactions
- **Submission Time Tracking**: Records when transactions are submitted to the network
- **Confirmation Checking**: Verifies transaction status on Stellar Horizon

### ✅ Automatic Fee Bumping
- **30-Second Threshold**: Transactions stuck for more than 30 seconds trigger fee bump
- **Exponential Fee Increase**: Fee doubles with each bump attempt
- **Maximum Fee Cap**: Prevents excessive fee increases (max 1 XLM)
- **Maximum Attempts**: Limits to 3 fee bump attempts per transaction

### ✅ Failure Handling
- **Stuck Transaction Detection**: Transactions failing after max attempts marked as failed
- **Metadata Tracking**: Complete history of fee bumps stored in transaction metadata
- **Logging**: Detailed logging of all fee bump operations

## How It Works

1. **Transaction Submission**: When a Stellar payment is sent, hash and timestamp are stored in metadata
2. **Monitoring**: Fee bump job runs every 30 seconds checking pending transactions
3. **Stuck Detection**: Identifies transactions submitted >30 seconds ago that aren't confirmed
4. **Fee Bumping**: Creates new transaction with higher fee using same operations
5. **Network Replacement**: Stellar network automatically replaces old transaction with higher fee
6. **Status Updates**: Confirmed transactions marked as completed

## Configuration

### Environment Variables

```bash
# Fee Bumping Configuration
FEE_BUMP_CRON="*/30 * * * * *"  # Every 30 seconds
STELLAR_ISSUER_SECRET=...      # Required for signing fee bumps
```

### Fee Bumping Limits

- **Initial Fee**: Stellar BASE_FEE (100 stroops)
- **Fee Multiplier**: 2x per bump
- **Maximum Fee**: 100,000 stroops (1 XLM)
- **Maximum Attempts**: 3 fee bumps
- **Monitoring Interval**: 30 seconds

## Metadata Structure

Fee bump information is stored in transaction metadata:

```json
{
  "stellar": {
    "transactionHash": "current_tx_hash",
    "submittedAt": "2024-01-01T12:00:00.000Z",
    "feeBumps": [
      {
        "previousHash": "old_tx_hash",
        "newHash": "new_tx_hash",
        "fee": 200,
        "bumpedAt": "2024-01-01T12:00:30.000Z"
      }
    ]
  }
}
```

## Acceptance Criteria Met

- ✅ **No Stuck Transactions**: Automatic fee bumping prevents indefinite pending states
- ✅ **High-Traffic Resilience**: Handles network congestion with progressive fee increases
- ✅ **Controlled Fee Escalation**: Exponential but capped fee increases
- ✅ **Transaction Tracking**: Complete audit trail of all fee bump attempts

## Monitoring

The system provides detailed logging:

```
[fee-bump] Found 2 transactions to check for fee bumping
[fee-bump] Transaction abc-123 is now confirmed
[fee-bump] Performed fee bump for transaction def-456
[fee-bump] Fee bumped transaction def-456 with new hash new_hash, fee: 200
```

## Testing

Unit tests cover:
- Fee bump job execution
- Transaction confirmation checking
- Fee calculation and limits
- Metadata updates
- Error handling

Run tests with:
```bash
npm test -- --testPathPattern=feeBump
```