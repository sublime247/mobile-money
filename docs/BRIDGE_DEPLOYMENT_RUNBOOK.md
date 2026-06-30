# Bridge Deployment & Operations Runbook

**Version:** 1.0 | **Status:** Production Ready | **Last Updated:** April 2026

---

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Deployment Procedures](#deployment-procedures)
3. [Operational Monitoring](#operational-monitoring)
4. [Incident Response](#incident-response)
5. [Maintenance Windows](#maintenance-windows)
6. [Rollback Procedures](#rollback-procedures)

---

## Pre-Deployment Checklist

### Code Quality

- [ ] All unit tests passing (>90% coverage)
- [ ] Integration tests passing on testnet
- [ ] No critical security issues in code scan
- [ ] Smart contracts audited by reputable firm
- [ ] Code reviewed by 2+ senior engineers
- [ ] Load testing completed (100+ tps)

### Infrastructure

- [ ] Validators configured and tested (3-5 nodes)
- [ ] Database migrations prepared and tested
- [ ] Redis instance provisioned for jobs
- [ ] Monitoring and alerting configured
- [ ] Log aggregation setup (ELK/Datadog)
- [ ] On-call rotation established

### Compliance & Security

- [ ] Legal review completed
- [ ] KYC/AML partner integration tested
- [ ] Sanctions check provider configured
- [ ] Audit logging enabled
- [ ] encryption keys secured (HSM)
- [ ] Rate limiting configured

### Documentation

- [ ] API documentation published
- [ ] Operations runbook prepared
- [ ] Disaster recovery plan documented
- [ ] Validator setup guide created
- [ ] Troubleshooting guide available

### Staging Validation

- [ ] E2E test passed on staging
- [ ] Performance benchmarks met
- [ ] Database backups tested
- [ ] Failover scenarios validated
- [ ] Monitoring for false positives

---

## Deployment Procedures

### Phase 1: Testnet Deployment

#### 1. Deploy Smart Contracts

```bash
# Deploy ERC20 wrapped token contract to Sepolia
npx hardhat run scripts/deploy-token.ts --network sepolia

# Deploy bridge vault contract to Sepolia
npx hardhat run scripts/deploy-vault.ts --network sepolia

# Verify contracts on Etherscan
npx hardhat verify \
  --network sepolia \
  --contract contracts/BridgedAssetVault.sol:BridgedAssetVault \
  <VAULT_ADDRESS> <TOKEN_ADDRESS> [VALIDATOR_ADDRESSES...]

# Output should show "✓ Pass - Verified"
```

#### 2. Configure Validators

```bash
# Register testnet validators (2-of-3 multisig)
npm run bridge:register-validators \
  --network testnet \
  --validator-1-stellar GABC... \
  --validator-1-evm 0x1234... \
  --validator-2-stellar GDEF... \
  --validator-2-evm 0x5678... \
  --validator-3-stellar GHIJ... \
  --validator-3-evm 0x9012... \
  --threshold 2

# Output: Validators registered successfully
# Validator IDs: validator-1, validator-2, validator-3
```

#### 3. Initialize Database

```bash
# Apply migrations
npm run db:migrate -- --environment testnet

# Verify schema
npm run db:schema:verify

# Seed initial data
npm run db:seed -- --environment testnet

# Output: ✓ 5 migrations applied, ✓ Schema verified
```

#### 4. Start Services

```bash
# Start bridge monitoring service
npm run service:bridge:start -- --network testnet

# Start validator attestation job
npm run job:validator-attestation:start -- --network testnet

# Start bridge sync job
npm run job:bridge-sync:start -- --network testnet

# Verify services are running
npm run service:health:check

# Expected output:
# bridge-service: ✓ running
# validator-job: ✓ running
# sync-job: ✓ running
```

#### 5. Run Smoke Tests

```bash
# Execute end-to-end test suite
npm run test:bridge:e2e -- --network testnet

# Sample output:
# ✓ KYC verification works
# ✓ Asset lock on Stellar works
# ✓ Validator consensus reached
# ✓ Mint on EVM works
# ✓ Complete flow: testnet (5min 30sec)
# ✓ Error handling works
# ✓ Rate limiting works
```

#### 6. Monitor for Stability

```bash
# Run continuous monitoring for 24 hours
npm run monitor:bridge \
  --duration 24h \
  --alert-on-errors \
  --alert-email ops@example.com

# Metrics collected:
# - Transaction latency
# - Validator consensus time
# - Error rate
# - System health
```

**Success Criteria (Testnet):**

- ✅ 50+ test transactions completed
- ✅ 0 transaction failures
- ✅ Validator consensus: 100%
- ✅ Lock→Mint latency: <5 minutes
- ✅ 0 critical alerts

---

### Phase 2: Production Deployment

#### Prerequisites

- [ ] Testnet deployment stable for 7+ days
- [ ] All team members trained
- [ ] Incident response plan reviewed
- [ ] Legal approval obtained

#### 1. Deploy Contracts to Mainnet

```bash
# Deploy to Ethereum mainnet (large deployment)
npx hardhat run scripts/deploy-vault.ts --network ethereum

# Deploy to Polygon mainnet (lower cost, redundancy)
npx hardhat run scripts/deploy-vault.ts --network polygon

# Verify on both BlockScout and Etherscan
npx hardhat verify --network ethereum <ADDRESS>
npx hardhat verify --network polygon <ADDRESS>
```

#### 2. Register Production Validators

```bash
# Setup primary validators (foundation-run)
npm run bridge:register-validators \
  --network mainnet \
  --type primary \
  --count 2 \
  --stake-amount 1000

# Setup secondary validators (exchange partners)
npm run bridge:register-validators \
  --network mainnet \
  --type secondary \
  --count 2 \
  --partners "kraken,coinbase" \
  --incentive-share 0.1

# Setup community validators
npm run bridge:register-validators \
  --network mainnet \
  --type community \
  --count 5 \
  --min-stake 100000
```

#### 3. Initialize with Conservative Limits

```bash
# Set initial limits (ramping up over time)
npm run bridge:config:set \
  --daily-limit 100000 \
  --per-tx-limit 10000 \
  --circuit-breaker-pct 20

# Output: Configuration applied
```

#### 4. Gradual Rollout

```bash
# Phase 2a: Tier 1 users only (KYC tier 1, <$5K/day)
npm run bridge:enable-tier \
  --tier 1 \
  --percentage 100

# Monitor for 24 hours

# Phase 2b: Add Tier 2 users (KYC tier 2, <$50K/day)
npm run bridge:enable-tier \
  --tier 2 \
  --percentage 100

# Monitor for 24 hours

# Phase 2c: Increase transaction limits
npm run bridge:config:set \
  --daily-limit 500000 \
  --per-tx-limit 50000

# Continue monitoring and gradually increase...
```

#### 5. Real-time Monitoring

```bash
# Setup continuous monitoring dashboard
# URL: https://ops.example.com/bridge/dashboard

# Key metrics to watch:
# - Bridge transactions per minute
# - Validator consensus time (target: <30s)
# - Error rate (target: <0.1%)
# - System uptime (target: 99.95%)
# - Daily volume
# - User growth
```

**Success Criteria (Production - Week 1):**

- ✅ 100+ transactions completed
- ✅ Uptime: >99.9%
- ✅ Error rate: <0.1%
- ✅ Consensus time: <30 seconds
- ✅ 0 security incidents

---

## Operational Monitoring

### Key Performance Indicators (KPIs)

```yaml
Bridge Health:
  uptime_target: 99.95%
  error_rate_target: 0.1% # Max 1 error per 1000 transactions
  consensus_time_target: 30s
  transaction_latency_target: 5min # Lock to Mint

Validator Performance:
  validator_uptime: 99.9% per validator
  signature_success_rate: 100%
  average_response_time: <5s

Business Metrics:
  daily_transaction_volume: $XXX
  daily_active_users: XXX
  average_transaction_size: $XX,XXX
  fee_revenue: $XX/day
```

### Monitoring Setup

#### Prometheus Metrics

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'bridge'
    static_configs:
      - targets: ['localhost:9090']

# Metrics exported:
bridge_transactions_initiated_total
bridge_transactions_locked_total
bridge_transactions_completed_total
bridge_transactions_failed_total
bridge_transaction_lock_duration_seconds
bridge_transaction_evm_mint_duration_seconds
bridge_validator_consensus_time_seconds
bridge_fee_collected_total_usd
bridge_validator_uptime_pct
bridge_error_rate
bridge_daily_volume_usd
```

#### Alert Rules

```yaml
# alerts.yml
groups:
  - name: bridge_alerts
    interval: 30s
    rules:
      # Critical Alerts
      - alert: BridgeHighErrorRate
        expr: rate(bridge_error_rate[5m]) > 0.001
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Bridge error rate exceeds 0.1%"
          runbook: "https://wiki.example.com/bridge-errors"

      - alert: ValidatorDown
        expr: bridge_validator_uptime_pct < 50
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.validator }} is down"

      - alert: ConsensusTimeout
        expr: bridge_validator_consensus_time_seconds > 60
        for: 5m
        labels:
          severity: high
        annotations:
          summary: "Consensus taking too long"

      # Warnings
      - alert: HighTransactionLatency
        expr: bridge_transaction_lock_duration_seconds > 600
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Transaction latency > 10 minutes"

      - alert: DailyLimitApproaching
        expr: bridge_daily_volume_usd > (bridge_daily_limit_usd * 0.8)
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Daily limit 80% utilized"
```

### Dashboards

**Bridge Operations Dashboard (Grafana)**

- Bridge transaction volume (hourly)
- Error rate (5-minute rolling)
- Validator consensus time
- Daily revenue
- User adoption
- Top transaction corridors (Stellar→EVM pathways)

**Validator Health Dashboard**

- Validator uptime per validator
- Response time per validator
- Signature success rate
- Reputation score trends
- Slashing incidents

---

## Incident Response

### Incident Severity Levels

| Level             | Response Time | Impact               | Examples                                                 |
| ----------------- | ------------- | -------------------- | -------------------------------------------------------- |
| **P1 - Critical** | <15 min       | Platform unavailable | Smart contract exploit, validator crash, liquidity drain |
| **P2 - High**     | <1 hour       | Degraded service     | High latency, 1 validator down, rate limiting triggered  |
| **P3 - Medium**   | <4 hours      | Minor issue          | Slow consensus, high error rate, API 5xx errors          |
| **P4 - Low**      | <1 day        | Non-urgent           | Documentation issues, analytics down                     |

### P1 Critical Response

#### Bridge Locked or Compromised

```bash
# 1. IMMEDIATE: Pause bridge (kill consensus)
npm run bridge:emergency-pause

# 2. Notify stakeholders
slack @ops-on-call "Bridge emergency paused - investigating"

# 3. Preserve evidence
npm run bridge:backup-state --output /backups/incident-state

# 4. Analyze root cause
# Check: validator logs, smart contract events, transaction history

# 5. Once root cause identified:

  # If smart contract bug:
  # a) Deploy patched contract
  # b) Migrate state to new contract
  # c) Gradually re-enable with tighter limits

  # If validator issue:
  # a) Remove malfunction validator
  # b) Activate backup validator
  # c) Re-run consensus signing

# 6. Restore service incrementally
npm run bridge:enable-tier --tier 1 --percentage 10  # 10% of tier 1
# Wait 15 minutes, monitor
npm run bridge:enable-tier --tier 1 --percentage 100  # All tier 1
# Wait 30 minutes, monitor
npm run bridge:enable-tier --tier 2 --percentage 100  # Tier 2 users
```

#### Lost Liquidity (Funds Drained)

```bash
# 1. Emergency pause
npm run bridge:emergency-pause

# 2. Trace stolen funds
npm run bridge:audit:trace-theft \
  --from-time <incident-time> \
  --output /logs/theft-analysis

# 3. Contact law enforcement
# Email: report@example.com with evidence

# 4. Communicate with users
# - Blog post: "Bridge Temporarily Suspended"
# - Email to affected users
# - Insurance claim (if applicable)

# 5. Security audit
npm run security:audit:emergency -- \
  --focus smart-contracts \
  --focus infrastructure

# 6. Plan recovery
# - Estimate recovery timeframe
# - Define compensation plan
# - Restore service when safe
```

### P2 High Severity

#### Validator Down (1 of 3)

```bash
# 1. Detect: Monitoring alerts
# "ValidatorDown: validator-2"

# 2. Investigate
npm run bridge:validator:status --validator validator-2
# Output: Last heartbeat: 15 minutes ago, Status: NO_RESPONSE

# 3. Attempt restart
npm run docker:restart bridge-validator-2

# 4. If restart fails: activate backup
npm run bridge:validator:activate-backup --for validator-2

# 5. Notify validator operator
email validator-ops@partner.com "Validator offline, activated backup"

# 6. Monitor consensus
npm run bridge:monitor:consensus --duration 1h

# Target: Consensus restored <5 minutes
```

#### High Error Rate (>1%)

```bash
# 1. Alert triggered
# "High error rate: 1.5% (threshold: 0.1%)"

# 2. Investigate error logs
npm run logs:search bridge --error-only --last-30m

# 3. Identify error type
# Common causes:
# - Stellar network congestion (check horizon status)
# - Gas prices too high (check EVM mempool)
# - KYC/AML system down (check compliance service)
# - Database connection pool exhausted

# 4. Apply fix
# Example: Increase gas price limit temporarily
npm run bridge:config:set --max-gas-price 100

# 5. Monitor recovery
npm run metrics:watch --duration 15m
```

### P3/P4 Response

Standard incident log template:

```yaml
Incident:
  id: INC-2026-04-26-001
  severity: P3
  created_at: 2026-04-26T14:30:00Z
  title: "High transaction latency"

  timeline:
    - 14:30 - Alert triggered: latency > 10 minutes
    - 14:35 - Investigation: Found Stellar network congestion
    - 14:40 - Mitigation: Increased timeout to 15 minutes
    - 15:00 - Resolution: Stellar network recovered, normal operation

  impact:
    - 5 transactions delayed >10 minutes
    - 0 transactions failed
    - Revenue impact: $0

  rootcause: "Stellar testnet network maintenance"

  remediation:
    - Add monitoring for network status
    - Cache Stellar availability checks

  postmortem_date: 2026-04-27
```

---

## Maintenance Windows

### Scheduled Maintenance

```
Schedule: Sundays 02:00 - 04:00 UTC
Duration: 2 hours (maximum)
Frequency: Monthly or as needed
```

### Pre-Maintenance Checklist

- [ ] Announce 72 hours before
- [ ] Verify backup exists
- [ ] Notify major users
- [ ] Dry-run on staging
- [ ] Have rollback plan ready
- [ ] Ensure on-call team available

### During Maintenance

```bash
# 1. Notify users (website banner + email)
npm run ops:maintenance:start \
  --message "Bridge under maintenance" \
  --duration 120

# 2. Put in maintenance mode
npm run bridge:maintenance:enable

# 3. Perform maintenance
# - Apply database migrations
# - Deploy new code
# - Update smart contracts (if needed)
# - Clear caches

# 4. Verify service health
npm run health:check

# 5. Exit maintenance mode
npm run bridge:maintenance:disable

# 6. Monitor closely for 1 hour post-maintenance
```

---

## Rollback Procedures

### Application Rollback (Quick)

```bash
# If current version has critical bug discovered in production

# 1. Pause new transactions
npm run bridge:emergency-pause

# 2. Revert code to previous version
git checkout HEAD~1
npm run build

# 3. Deploy previous version
npm run deploy:production --version v1.2.0

# 4. Verify health
npm run health:check

# 5. Resume operations
npm run bridge:resume
```

### Smart Contract Rollback (Planned - Time Required)

```bash
# For production smart contract issues
# Requires: multi-sig transaction + time-lock

# 1. Create rollback proposal
npm run bridge:contract:propose-rollback \
  --from-address 0x... \
  --to-version v1.2.0

# 2. Multi-sig validators vote (requires 2-of-3)
npm run bridge:contract:vote \
  --proposal-id 5 \
  --vote yes

# 3. Wait for voting period (48 hours) + timelock (24 hours)

# 4. Execute rollback
npm run bridge:contract:execute \
  --proposal-id 5
```

---

## Emergency Contacts

```
On-Call Engineer:  <PHONE>
Engineering Lead:  <EMAIL>
Operations Lead:   <EMAIL>
Legal:            <EMAIL>
Compliance:       <EMAIL>
Security:         <EMAIL>

Escalation Path:
Level 1: On-call engineer (response <15 min)
Level 2: Engineering lead (response <30 min)
Level 3: Director (response <1 hour)
Level 4: CTO (response <2 hours)
```

---

## Playbooks

### Playbook: Performance Degradation

```
Symptom: Consensus taking >1 minute
Possible Causes:
  1. Validator network latency (check ping)
  2. Stellar network congestion (check horizon)
  3. Database query slowdown (check connections)

Steps:
  1. Run: npm run bridge:diagnostics
  2. If cause #1: Contact ISP, activate backup path
  3. If cause #2: Monitor trend, may resolve automatically
  4. If cause #3: Increase connection pool, restart service

Success: Consensus restores to <30s
```

### Playbook: User Complaints of Failed Transactions

```
Symptom: Users report transactions stuck/failed
Steps:
  1. Check bridge status: npm run bridge:status
  2. Get transaction ID from user
  3. Query status: npm run bridge:tx:get --id <TX_ID>
  4. Categorize issue:
     - Pending: May complete, check latency
     - Failed: Generate support ticket
     - Locked: Try unlock command
  5. Notify user of resolution ETA
```

---
