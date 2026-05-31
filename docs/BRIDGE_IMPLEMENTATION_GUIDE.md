# Bridge Implementation Guide

**Version:** 1.0 | **Date:** April 2026 | **Status:** Phase 1 Prototype

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Service Architecture](#service-architecture)
3. [Implementation Steps](#implementation-steps)
4. [Testing Strategy](#testing-strategy)
5. [Deployment](#deployment)
6. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Prerequisites

- Node.js 18+, TypeScript
- Stellar SDK (`stellar-sdk`)
- Ethers.js or Web3.js
- PostgreSQL 14+
- Redis (for job queue)
- AWS account (for HSM/KMS)

### Installation

```bash
# Install dependencies
npm install stellar-sdk ethers dotenv axios joi zod

# Setup environment
cp .env.example .env.template
# Edit .env.template with your values

# Create database schema
npm run db:migrate:bridge

# Initialize validators
npm run bridge:init-validators
```

### First Bridge Transaction (Testnet)

```bash
# 1. Lock assets on Stellar (testnet)
npm run bridge:lock \
  --amount 100 \
  --asset USDC \
  --recipient ethereum:0x1234...

# 2. Monitor transaction status
npm run bridge:status --tx-id <bridge-tx-id>

# 3. Check EVM side (check etherscan/polygonscan)
```

---

## Service Architecture

### Service Layer

```
Bridge Transaction Flow
=======================

┌────────────────┐
│ User Request   │
│ (Lock Request) │
└────────┬───────┘
         │
         ▼
┌────────────────────────┐
│ BridgeService          │
│ - Route to action      │
│ - Validate request     │
└────────┬───────────────┘
         │
         ├─────────────────┬──────────────────┬──────────────────┐
         │                 │                  │                  │
         ▼                 ▼                  ▼                  ▼
    ┌─────────┐    ┌──────────────┐  ┌────────────┐  ┌──────────────┐
    │ KYC     │    │ Stellar      │  │ Validator  │  │ Monitor      │
    │ Check   │    │ Lock Service │  │ Service    │  │ Service      │
    └──┬──────┘    └──────┬───────┘  └─────┬──────┘  └──────┬───────┘
       │                  │                │               │
       └──────────────────┼────────────────┼───────────────┘
                          │
                    ┌─────▼──────┐
                    │ Database   │
                    │ (Store Tx) │
                    └────────────┘
```

### Service Types

| Service                  | Purpose              | Key Methods                                |
| ------------------------ | -------------------- | ------------------------------------------ |
| **BridgeService**        | Main orchestrator    | initiate(), lock(), redeem(), getStatus()  |
| **StellarLockService**   | Stellar operations   | lock(), verify(), unlock()                 |
| **EVMMintService**       | EVM operations       | mint(), burn(), deployVault()              |
| **ValidatorService**     | Signature management | collectSignatures(), verifyConsensus()     |
| **BridgeMonitorService** | State tracking       | trackTransactionState(), detectAnomalies() |
| **ComplianceService**    | AML/KYC              | checkKYC(), checkSanctions(), verifyTier() |

---

## Implementation Steps

### Step 1: Create Database Migrations

```sql
-- migration_001_bridge_tables.sql

-- Bridge transactions table
CREATE TABLE bridge_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_chain VARCHAR(50) NOT NULL,
  target_chain VARCHAR(50) NOT NULL,
  asset_code VARCHAR(12) NOT NULL,
  amount DECIMAL(19, 7) NOT NULL,

  status VARCHAR(50) NOT NULL DEFAULT 'initiated',
  -- Status flow: initiated -> kyc_verified -> stellar_locked -> validator_consensus -> evm_minted -> completed

  stellar_lock_tx_hash VARCHAR(64) UNIQUE,
  stellar_lock_timestamp TIMESTAMP,

  evm_mint_tx_hash VARCHAR(66) UNIQUE,
  evm_mint_timestamp TIMESTAMP,
  evm_recipient_address VARCHAR(42) NOT NULL,

  validator_signatures JSONB,
  consensus_ratio DECIMAL(3, 2),

  fee_amount DECIMAL(19, 7),
  fee_percent DECIMAL(5, 2),

  metadata JSONB,
  error_message TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at DESC),
  INDEX idx_stellar_hash (stellar_lock_tx_hash),
  INDEX idx_evm_hash (evm_mint_tx_hash)
);

-- Bridge validators table
CREATE TABLE bridge_validators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  validator_type VARCHAR(50) NOT NULL, -- primary, secondary, community

  public_key_stellar VARCHAR(56) NOT NULL UNIQUE,
  public_key_evm VARCHAR(42) NOT NULL UNIQUE,

  endpoint_url VARCHAR(255) NOT NULL,
  signing_method VARCHAR(50), -- hsm, kms, local

  stake_amount DECIMAL(19, 7),
  reputation_score DECIMAL(5, 2) DEFAULT 100.0,
  uptime_pct DECIMAL(5, 2) DEFAULT 100.0,
  slashing_balance DECIMAL(19, 7) DEFAULT 0,

  active BOOLEAN DEFAULT TRUE,
  last_heartbeat TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  INDEX idx_active (active),
  INDEX idx_type (validator_type)
);

-- Validator attestations table
CREATE TABLE validator_attestations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bridge_transaction_id UUID NOT NULL REFERENCES bridge_transactions(id) ON DELETE CASCADE,
  validator_id UUID NOT NULL REFERENCES bridge_validators(id) ON DELETE CASCADE,

  signature_hex VARCHAR(500) NOT NULL,
  signed_at TIMESTAMP DEFAULT NOW(),
  verified BOOLEAN DEFAULT FALSE,

  UNIQUE(bridge_transaction_id, validator_id),
  INDEX idx_transaction (bridge_transaction_id),
  INDEX idx_verified (verified)
);

-- Locked assets state
CREATE TABLE locked_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bridge_transaction_id UUID NOT NULL UNIQUE REFERENCES bridge_transactions(id) ON DELETE CASCADE,

  escrow_account VARCHAR(56) NOT NULL,
  locked_in_escrow_timestamp TIMESTAMP,
  unlock_time TIMESTAMP,

  timelock_blocks BIGINT,
  timelocked BOOLEAN DEFAULT FALSE,

  reversion_reason VARCHAR(500),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  INDEX idx_escrow (escrow_account),
  INDEX idx_tx (bridge_transaction_id)
);

-- Bridge audit log
CREATE TABLE bridge_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bridge_transaction_id UUID REFERENCES bridge_transactions(id) ON DELETE SET NULL,
  event_type VARCHAR(100) NOT NULL,
  details JSONB NOT NULL,
  actor VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),

  INDEX idx_tx_id (bridge_transaction_id),
  INDEX idx_created_at (created_at DESC),
  INDEX idx_event_type (event_type)
);
```

### Step 2: Create TypeScript Service Base

```typescript
// src/services/bridge/types.ts

export interface BridgeTransaction {
  id: string;
  userId: string;
  sourceChain: "stellar" | "ethereum" | "polygon";
  targetChain: "stellar" | "ethereum" | "polygon";
  assetCode: string;
  amount: BigNumber;

  status: BridgeTransactionStatus;
  stellarLockTxHash?: string;
  evmMintTxHash?: string;
  evmRecipientAddress: string;

  validatorSignatures: ValidatorSignature[];
  consensusRatio: number;

  feeAmount: BigNumber;
  feePercent: number;

  createdAt: Date;
  updatedAt: Date;
}

export type BridgeTransactionStatus =
  | "initiated"
  | "kyc_verified"
  | "stellar_locked"
  | "validator_consensus"
  | "evm_minted"
  | "completed"
  | "failed"
  | "reversed";

export interface ValidatorSignature {
  validatorId: string;
  signature: string;
  signedAt: Date;
  verified: boolean;
}

export interface BridgeValidator {
  id: string;
  name: string;
  type: "primary" | "secondary" | "community";
  publicKeyStellar: string;
  publicKeyEVM: string;
  endpointUrl: string;
  active: boolean;
  reputationScore: number;
  uptimePct: number;
}
```

### Step 3: Implement Core Services

See [Bridge Service Prototypes](#service-prototypes) below for full implementation.

### Step 4: Create API Endpoints

```typescript
// src/routes/bridgeRouter.ts

import { Router } from "express";
import { BridgeController } from "../controllers/bridgeController";
import { authMiddleware, validateRequest } from "../middleware";

const router = Router();
const bridgeController = new BridgeController();

// Public endpoints
router.get("/status/:txId", bridgeController.getTransactionStatus);
router.get("/quotes", bridgeController.getQuote);

// Authenticated endpoints
router.post(
  "/lock",
  authMiddleware,
  validateRequest(LockRequestSchema),
  bridgeController.initiatelock,
);

router.post(
  "/redeem",
  authMiddleware,
  validateRequest(RedeemRequestSchema),
  bridgeController.initiateRedeem,
);

router.get(
  "/transactions",
  authMiddleware,
  bridgeController.listUserTransactions,
);

export default router;
```

### Step 5: Configure Jobs

```typescript
// src/jobs/bridgeSyncJob.ts

import { Job } from "bull";
import { BridgeMonitorService } from "../services/bridge/bridgeMonitorService";
import logger from "../logger";

export async function bridgeSyncJob(job?: Job) {
  logger.info("[BridgeSync] Starting bridge transaction sync...");

  try {
    const monitor = new BridgeMonitorService();

    // Sync pending transactions
    const pendingTxs = await BridgeTransaction.find({
      status: "validator_consensus",
    });

    for (const tx of pendingTxs) {
      await monitor.trackTransactionState(tx.id);
    }

    // Check for anomalies
    await monitor.detectAnomalies();

    logger.info("[BridgeSync] Sync completed successfully");
    return { processed: pendingTxs.length };
  } catch (error) {
    logger.error("[BridgeSync] Error:", error);
    throw error;
  }
}

// Cron configuration
export const bridgeSyncJobConfig = {
  name: "bridge-sync",
  pattern: "*/5 * * * *", // Every 5 minutes
  processor: bridgeSyncJob,
};
```

---

## Testing Strategy

### Unit Tests

```typescript
// src/services/bridge/__tests__/bridgeService.test.ts

describe("BridgeService", () => {
  let bridgeService: BridgeService;
  let mockStellarService: jest.Mocked<StellarLockService>;
  let mockValidatorService: jest.Mocked<ValidatorService>;

  beforeEach(() => {
    mockStellarService = createMockStellarService();
    mockValidatorService = createMockValidatorService();
    bridgeService = new BridgeService(mockStellarService, mockValidatorService);
  });

  test("should successfully lock asset on Stellar", async () => {
    const lockRequest = {
      userId: "user-123",
      amount: new BigNumber("100"),
      assetCode: "USDC",
      sourceChain: "stellar",
      targetChain: "ethereum",
      evmRecipient: "0x1234...",
    };

    mockStellarService.lock.mockResolvedValue({
      txHash: "abc123...",
      timestamp: new Date(),
    });

    const result = await bridgeService.initiateLock(lockRequest);

    expect(result.status).toBe("stellar_locked");
    expect(result.stellarLockTxHash).toBe("abc123...");
  });

  test("should require 2-of-3 validator consensus", async () => {
    const tx = createTestBridgeTransaction();

    mockValidatorService.verifyConsensus.mockResolvedValue({
      consensus: false,
      signatures: 1,
      required: 2,
      message: "Insufficient signatures",
    });

    const result = await bridgeService.checkValidatorConsensus(tx.id);

    expect(result.consensus).toBe(false);
  });
});
```

### Integration Tests

```typescript
// tests/bridge/bridge.integration.test.ts

describe("Bridge Integration Tests", () => {
  // Testnet fixture
  const testFixture = {
    stellarTestnet: "https://horizon-testnet.stellar.org",
    ethereumSepolia: "https://sepolia.infura.io/v3/...",
    validators: ["validator-1", "validator-2", "validator-3"],
  };

  test("End-to-end: Stellar -> Ethereum bridge", async () => {
    // 1. Create user and KYC
    const user = await createTestUser();
    await updateUserKYCStatus(user.id, "approved");

    // 2. Lock on Stellar
    const lockRequest = {
      userId: user.id,
      amount: new BigNumber("100"),
      assetCode: "USDC-testnet",
      evmRecipient: USER_EVM_ADDRESS,
    };

    const tx = await bridgeService.initiateLock(lockRequest);
    expect(tx.status).toBe("stellar_locked");

    // 3. Wait for validator consensus
    await waitForValidatorConsensus(tx.id, 30000);

    // 4. Verify EVM mint
    const evmBalance = await getEVMBalance(USER_EVM_ADDRESS);
    expect(evmBalance).toEqual(new BigNumber("100"));
  }, 60000); // 60 second timeout
});
```

---

## Deployment

### Pre-Deployment Checklist

- [ ] All tests passing (unit + integration)
- [ ] Code review completed
- [ ] Security audit passed (third-party audit for contracts)
- [ ] Validators configured and tested
- [ ] Database migrations applied
- [ ] Environment variables configured
- [ ] Monitoring and alerting setup
- [ ] Runbook documentation complete

### Deployment Steps

#### Testnet Deployment (Phase 1)

```bash
# 1. Deploy smart contracts to Sepolia testnet
npm run hardhat:deploy --network sepolia

# 2. Initialize bridge vault
npm run bridge:init-vault

# 3. Register validators (testnet)
npm run bridge:register-validators --network testnet --validators 2-of-3

# 4. Run smoke tests
npm run test:bridge:smoke

# 5. Monitor for 24 hours
npm run monitor:bridge --duration 24h
```

#### Production Deployment (Phase 2)

```bash
# 1. Deploy to Ethereum mainnet (staged)
npm run hardhat:deploy --network ethereum --verify

# 2. Deploy to Polygon mainnet
npm run hardhat:deploy --network polygon --verify

# 3. Initialize production validators
npm run bridge:register-validators \
  --network mainnet \
  --primary-validators 2 \
  --secondary-validators 2

# 4. Gradual rollout with volume limits
npm run bridge:set-limits \
  --daily-limit 100000 \
  --per-tx-limit 10000

# 5. Enable monitoring and alerting
npm run bridge:enable-monitoring
```

---

## Troubleshooting

### Common Issues

#### Issue: "Insufficient Validator Signatures"

```
Error: Validator consensus not reached
  Signatures: 1/2 required
```

**Solution:**

1. Check validator health: `npm run bridge:check-validators`
2. Restart failing validators
3. Check network connectivity
4. Review validator logs: `docker logs validator-1`

#### Issue: "Stellar Transaction Timeout"

```
Error: Lock transaction timeout after 5 minutes
```

**Solution:**

1. Check Stellar network status: `curl https://horizon.stellar.org/health`
2. Increase timeout: `STELLAR_TX_TIMEOUT=600000`
3. Retry transaction: `npm run bridge:retry-tx --tx-id <id>`

#### Issue: "EVM Gas Price Too High"

```
Error: Gas price exceeds max allowed (100 Gwei)
```

**Solution:**

1. Wait for gas to decrease
2. Adjust `EVM_GAS_LIMIT` temporarily
3. Check Ethereum network: `npm run bridge:check-evm-network`

---

## Monitoring & Observability

### Key Metrics

```typescript
// Prometheus metrics
bridge_transactions_total;
bridge_transactions_locked_duration_seconds;
bridge_validator_consensus_time_seconds;
bridge_fee_collected_total_usd;
bridge_lock_revert_rate;
bridge_error_rate;
```

### Alerting Rules

```yaml
# alerts.yml
groups:
  - name: bridge_alerts
    rules:
      - alert: BridgeHighErrorRate
        expr: rate(bridge_error_rate[5m]) > 0.01
        for: 10m
        annotations:
          summary: "Bridge error rate > 1%"

      - alert: BridgeValidatorDown
        expr: bridge_validator_uptime < 0.95
        for: 5m
        annotations:
          summary: "Validator uptime < 95%"
```

---

## Resource Links

- [Stellar Documentation](https://developers.stellar.org)
- [Ethers.js Docs](https://docs.ethers.org)
- [Allbridge API Reference](https://allbridge.io/docs/api)
- [SEP-41 Standard](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0041.md)
