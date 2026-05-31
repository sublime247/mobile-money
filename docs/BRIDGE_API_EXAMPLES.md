# Bridge API Usage Examples

**Version:** 1.0 | **Status:** Prototype Examples

---

## Overview

This document provides practical examples of how to interact with the mobile money bridge API for cross-chain asset transfers.

---

## Authentication

All API requests require Bearer token authentication:

```bash
# Get token
TOKEN=$(curl -X POST https://api.example.com/auth/token \
  -d '{"email":"user@example.com","password":"..."}' \
  | jq -r '.token')

# Use in requests
curl -H "Authorization: Bearer $TOKEN" https://api.example.com/bridge/...
```

---

## Examples

### 1. Get Bridge Quote

Query exchange rates and fees before initiating a transfer:

```bash
curl -X GET "https://api.example.com/v1/bridge/quotes" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceChain": "stellar",
    "targetChain": "ethereum",
    "assetCode": "USDC",
    "amount": "1000"
  }' \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**

```json
{
  "sourceChain": "stellar",
  "targetChain": "ethereum",
  "assetCode": "USDC",
  "amountIn": "1000",
  "amountOut": "994.75",
  "fee": "5.25",
  "feePercent": 0.525,
  "exchangeRate": "1.0",
  "estimatedTime": "5 minutes",
  "quotelExpiry": "2026-04-26T15:10:00Z"
}
```

### 2. Check User KYC Status

Before initiating a bridge transaction, verify user's KYC tier:

```bash
curl -X GET "https://api.example.com/v1/user/kyc-status" \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**

```json
{
  "userId": "user-123",
  "kycStatus": "approved",
  "tier": "tier2",
  "dailyLimit": "50000",
  "remainingDailyLimit": "48000",
  "totalMinted": "2000",
  "totalLocked": "2000"
}
```

### 3. Initiate Lock Transaction

Lock assets on Stellar for bridging to EVM:

```bash
curl -X POST "https://api.example.com/v1/bridge/lock" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "amount": "100",
    "assetCode": "USDC",
    "sourceChain": "stellar",
    "targetChain": "ethereum",
    "evmRecipient": "0x1234567890abcdef1234567890abcdef12345678",
    "memo": "optional-memo"
  }'
```

**Request Body:**

```typescript
interface LockRequest {
  amount: string; // e.g., "100"
  assetCode: string; // e.g., "USDC"
  sourceChain: "stellar" | "ethereum" | "polygon";
  targetChain: "ethereum" | "polygon" | "stellar";
  evmRecipient?: string; // Required if targetChain is EVM
  memo?: string; // Optional reference
}
```

**Response (201 Created):**

```json
{
  "bridgeTransactionId": "BRIDGE-1714158600000-abc123",
  "status": "stellar_locked",
  "statusProgress": 40,
  "sourceChain": "stellar",
  "targetChain": "ethereum",
  "assetCode": "USDC",
  "amount": "100",
  "fee": "0.525",
  "stellarTxHash": "5f36a7cae8c2d4e55c7b8a9f2e3b1a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
  "evmRecipient": "0x1234567890abcdef1234567890abcdef12345678",
  "validatorSignatures": 1,
  "requiredValidators": 2,
  "estimatedMintTime": "2026-04-26T14:35:00Z",
  "createdAt": "2026-04-26T14:30:00Z",
  "updatedAt": "2026-04-26T14:30:00Z"
}
```

### 4. Poll Transaction Status

Monitor bridge transaction progress:

```bash
curl -X GET "https://api.example.com/v1/bridge/transactions/BRIDGE-1714158600000-abc123" \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**

```json
{
  "bridgeTransactionId": "BRIDGE-1714158600000-abc123",
  "status": "evm_minted",
  "statusProgress": 80,
  "details": {
    "amount": "100",
    "sourceChain": "stellar",
    "targetChain": "ethereum",
    "stellarTxHash": "5f36a7cae8c2d4e55c7b8a9f2e3b1a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
    "evmTxHash": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "evmRecipient": "0x1234567890abcdef1234567890abcdef12345678",
    "validatorSignatures": 2,
    "requiredValidators": 2,
    "gasUsed": "45000",
    "gasPrice": "25 Gwei",
    "createdAt": "2026-04-26T14:30:00Z",
    "updatedAt": "2026-04-26T14:34:00Z"
  }
}
```

**Status Progress Mapping:**

```
initiated:         10%
kyc_verified:      20%
stellar_locked:    40%
validator_consensus: 60%
evm_minted:        80%
completed:         100%
```

### 5. List User Transactions

Retrieve user's bridge transaction history:

```bash
curl -X GET "https://api.example.com/v1/bridge/transactions?limit=10&offset=0&status=completed" \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**

```json
{
  "total": 5,
  "limit": 10,
  "offset": 0,
  "transactions": [
    {
      "bridgeTransactionId": "BRIDGE-1714158600000-abc123",
      "status": "completed",
      "amount": "100",
      "sourceChain": "stellar",
      "targetChain": "ethereum",
      "fee": "0.525",
      "amountReceived": "99.475",
      "createdAt": "2026-04-26T14:30:00Z",
      "completedAt": "2026-04-26T14:35:00Z"
    }
  ]
}
```

### 6. Initiate Redemption (Reverse Flow)

Burn wrapped tokens on EVM to unlock on Stellar:

```bash
curl -X POST "https://api.example.com/v1/bridge/redeem" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "originalBridgeTxId": "BRIDGE-1714158600000-abc123",
    "evmTxHash": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "amount": "100"
  }'
```

**Response:**

```json
{
  "redemptionTxId": "REDEEM-1714158800000-def456",
  "status": "initiated",
  "originalBridgeTxId": "BRIDGE-1714158600000-abc123",
  "amount": "100",
  "evmBurnTxHash": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "estimatedUnlockTime": "2026-04-26T14:42:00Z",
  "createdAt": "2026-04-26T14:37:00Z"
}
```

### 7. Get Bridge Status & Limits

Check overall bridge health and user limits:

```bash
curl -X GET "https://api.example.com/v1/bridge/status" \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**

```json
{
  "bridgeStatus": "operational",
  "isPaused": false,
  "validatorConsensus": {
    "activeValidators": 3,
    "requiredSignatures": 2,
    "averageResponseTime": "15s"
  },
  "limits": {
    "dailyBridgeLimit": "500000",
    "dailyUsed": "145000",
    "dailyRemaining": "355000",
    "userTransactionLimit": "50000",
    "userDailyUsed": "5000",
    "userDailyRemaining": "45000"
  },
  "assets": {
    "supportedAssets": ["USDC", "EUROC", "XLM"],
    "pairs": [
      {
        "source": "stellar",
        "target": "ethereum",
        "assets": ["USDC", "EUROC"]
      }
    ]
  },
  "timestamp": "2026-04-26T14:40:00Z"
}
```

---

## Error Handling

### Error Response Format

```json
{
  "error": {
    "code": "INSUFFICIENT_KYC",
    "message": "User KYC verification in progress",
    "details": {
      "kycStatus": "pending",
      "estimatedCompletion": "2026-04-27T10:00:00Z"
    },
    "timestamp": "2026-04-26T14:40:00Z"
  }
}
```

### Common Error Codes

| Code                          | HTTP | Meaning                   | Solution                   |
| ----------------------------- | ---- | ------------------------- | -------------------------- |
| `INSUFFICIENT_KYC`            | 403  | KYC not completed         | Complete KYC verification  |
| `TRANSACTION_LIMIT_EXCEEDED`  | 422  | Amount exceeds limit      | Check daily limits         |
| `SANCTIONS_CHECK_FAILED`      | 403  | Sanctions list match      | Contact support            |
| `INVALID_EVM_ADDRESS`         | 400  | Invalid recipient address | Verify EVM address format  |
| `BRIDGE_PAUSED`               | 503  | Bridge maintenance        | Try again later            |
| `INSUFFICIENT_LIQUIDITY`      | 503  | Not enough liquidity      | Reduce amount or try later |
| `VALIDATOR_CONSENSUS_TIMEOUT` | 504  | Validator timeout         | Try again                  |

---

## Code Examples

### JavaScript/Node.js

```javascript
import axios from "axios";

class BridgeClient {
  constructor(baseURL, token) {
    this.client = axios.create({
      baseURL,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  }

  async initiateLock(request) {
    const response = await this.client.post("/v1/bridge/lock", request);
    return response.data;
  }

  async getStatus(txId) {
    const response = await this.client.get(`/v1/bridge/transactions/${txId}`);
    return response.data;
  }

  async pollUntilCompleted(txId, maxAttempts = 60, interval = 5000) {
    let attempts = 0;

    while (attempts < maxAttempts) {
      const status = await this.getStatus(txId);

      if (status.status === "completed") {
        return status;
      }

      if (status.status === "failed") {
        throw new Error(`Transaction failed: ${status.errorMessage}`);
      }

      await new Promise((r) => setTimeout(r, interval));
      attempts++;
    }

    throw new Error("Transaction polling timeout");
  }
}

// Usage
const bridge = new BridgeClient("https://api.example.com", token);

const tx = await bridge.initiateLock({
  amount: "100",
  assetCode: "USDC",
  sourceChain: "stellar",
  targetChain: "ethereum",
  evmRecipient: "0x...",
});

console.log("Bridge TX:", tx.bridgeTransactionId);

const completed = await bridge.pollUntilCompleted(tx.bridgeTransactionId);
console.log("Completed:", completed);
```

### Python

```python
import requests
import time

class BridgeClient:
    def __init__(self, base_url, token):
        self.base_url = base_url
        self.headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }

    def initiate_lock(self, request):
        response = requests.post(
            f'{self.base_url}/v1/bridge/lock',
            json=request,
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()

    def get_status(self, tx_id):
        response = requests.get(
            f'{self.base_url}/v1/bridge/transactions/{tx_id}',
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()

    def poll_until_completed(self, tx_id, max_attempts=60, interval=5):
        for attempt in range(max_attempts):
            status = self.get_status(tx_id)

            if status['status'] == 'completed':
                return status

            if status['status'] == 'failed':
                raise Exception(f"Transaction failed: {status.get('error_message')}")

            time.sleep(interval)

        raise TimeoutError('Transaction polling timeout')

# Usage
bridge = BridgeClient('https://api.example.com', token)

tx = bridge.initiate_lock({
    'amount': '100',
    'assetCode': 'USDC',
    'sourceChain': 'stellar',
    'targetChain': 'ethereum',
    'evmRecipient': '0x...'
})

print(f"Bridge TX: {tx['bridgeTransactionId']}")

completed = bridge.poll_until_completed(tx['bridgeTransactionId'])
print(f"Completed: {completed}")
```

---

## Webhook Events

Optional: Subscribe to bridge events via webhooks:

```bash
curl -X POST "https://api.example.com/v1/webhooks" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "url": "https://your-app.com/webhooks/bridge",
    "events": [
      "bridge.transaction.locked",
      "bridge.transaction.minted",
      "bridge.transaction.completed",
      "bridge.transaction.failed"
    ]
  }'
```

**Webhook Payload:**

```json
{
  "event": "bridge.transaction.minted",
  "bridgeTransactionId": "BRIDGE-1714158600000-abc123",
  "status": "evm_minted",
  "timestamp": "2026-04-26T14:34:00Z",
  "data": {
    "amount": "100",
    "evmTxHash": "0x1234..."
  }
}
```

---

## Rate Limiting

- **Authenticated requests:** 1000 req/hour
- **Quote requests:** 100 req/minute
- **Status checks:** 500 req/minute

Headers returned:

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1714162800
```

---

## Best Practices

1. **Always verify EVM addresses** with a checksum before submitting
2. **Use quotes** to get accurate fees and rates
3. **Poll status** instead of assuming completion time
4. **Handle retries** with exponential backoff
5. **Log all transactions** with their IDs for auditing
6. **Use webhooks** for production systems instead of polling
7. **Implement timeouts** (typically 10-15 minutes for completion)
