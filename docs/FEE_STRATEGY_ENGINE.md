# Dynamic Fee Strategy Engine

## Overview

The Fee Strategy Engine replaces the single-config fee system with a composable, priority-aware rule engine. Marketing and operations teams can configure and activate fee campaigns (like "Fee-free Fridays") in real time through the REST API — no code changes or restarts required.

---

## Architecture

```
FeeCalculationContext
  { amount, userId?, provider?, evaluationTime? }
          │
          ▼
  FeeStrategyEngine.calculateFee()
          │
          ├─ 1. Fetch active strategies from DB (Redis-cached, 60s TTL)
          │
          ├─ 2. Order by priority hierarchy:
          │      user-scope  (priority ASC)
          │      provider-scope (priority ASC)
          │      global-scope (priority ASC)
          │
          └─ 3. Apply first matching strategy → FeeCalculationResult
```

### Strategy Types

| Type           | Description                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `flat`         | Fixed fee amount regardless of transaction size                                                       |
| `percentage`   | Percentage of amount, clamped to `[feeMinimum, feeMaximum]`                                           |
| `time_based`   | Overrides fee during specific days/hours (e.g. Fee-free Fridays). Falls through if condition not met. |
| `volume_based` | Tiered fee based on transaction amount brackets                                                       |

### Priority Hierarchy

```
User-specific  >  Provider-specific  >  Global/default
```

Within the same scope, lower `priority` number wins (e.g. priority 10 beats priority 100).

---

## API Reference

All admin endpoints require `Authorization: Bearer <token>` and the `admin:system` permission.

### Calculate Fee (public)

```
POST /api/fee-strategies/calculate
```

**Body:**

```json
{
  "amount": 10000,
  "userId": "uuid (optional)",
  "provider": "orange (optional)",
  "evaluationTime": "2026-04-24T12:00:00Z (optional, for testing)"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "fee": 150,
    "total": 10150,
    "strategyUsed": "Global 1.5%",
    "scopeUsed": "global",
    "timeOverrideActive": false,
    "breakdown": {
      "strategyId": "...",
      "strategyType": "percentage",
      "rawFee": 150,
      "clampedFee": 150
    }
  }
}
```

### List Strategies (admin)

```
GET /api/fee-strategies
```

### Create Strategy (admin)

```
POST /api/fee-strategies
```

### Get Strategy (admin)

```
GET /api/fee-strategies/:id
```

### Update Strategy (admin)

```
PUT /api/fee-strategies/:id
```

### Delete Strategy (admin)

```
DELETE /api/fee-strategies/:id
```

### Activate / Deactivate (admin)

```
POST /api/fee-strategies/:id/activate
POST /api/fee-strategies/:id/deactivate
```

### Audit History (admin)

```
GET /api/fee-strategies/:id/audit
```

---

## Example Configurations

### 1. Standard Global Fee (1.5%, min ₦50, max ₦5,000)

```json
{
  "name": "Standard 1.5%",
  "description": "Default fee for all transactions",
  "strategyType": "percentage",
  "scope": "global",
  "priority": 100,
  "feePercentage": 1.5,
  "feeMinimum": 50,
  "feeMaximum": 5000
}
```

---

### 2. Fee-free Fridays (Marketing Campaign)

Marketing can create this via the API — no developer needed.

```json
{
  "name": "Fee-free Fridays",
  "description": "Zero-fee promotion every Friday — configured by marketing",
  "strategyType": "time_based",
  "scope": "global",
  "priority": 10,
  "daysOfWeek": [5],
  "overridePercentage": 0
}
```

`daysOfWeek` uses ISO weekday numbers: 1=Monday … 7=Sunday.

To limit to business hours only:

```json
{
  "daysOfWeek": [5],
  "timeStart": "08:00",
  "timeEnd": "20:00",
  "overridePercentage": 0
}
```

---

### 3. Weekend Flat Fee Promotion

```json
{
  "name": "Weekend ₦100 Flat Fee",
  "strategyType": "time_based",
  "scope": "global",
  "priority": 10,
  "daysOfWeek": [6, 7],
  "overrideFlatAmount": 100
}
```

---

### 4. Volume-Based Tiered Fee

Reduced fee for high-value transactions:

```json
{
  "name": "Volume Tiers",
  "strategyType": "volume_based",
  "scope": "global",
  "priority": 50,
  "volumeTiers": [
    { "minAmount": 0, "maxAmount": 100000, "feePercentage": 1.5 },
    { "minAmount": 100000, "maxAmount": 500000, "feePercentage": 0.8 },
    { "minAmount": 500000, "maxAmount": null, "feePercentage": 0.5 }
  ]
}
```

---

### 5. Provider-Specific Fee (Orange Money)

```json
{
  "name": "Orange Money 1%",
  "strategyType": "percentage",
  "scope": "provider",
  "provider": "orange",
  "priority": 50,
  "feePercentage": 1.0,
  "feeMinimum": 30,
  "feeMaximum": 3000
}
```

---

### 6. VIP User Override (0.2% fee)

```json
{
  "name": "VIP User Override",
  "strategyType": "percentage",
  "scope": "user",
  "userId": "<user-uuid>",
  "priority": 1,
  "feePercentage": 0.2,
  "feeMinimum": 0,
  "feeMaximum": 500
}
```

---

## How "Fee-free Fridays" Works End-to-End

1. Marketing calls `POST /api/fee-strategies` with the Fee-free Fridays payload above.
2. The strategy is stored in the DB with `is_active = true`.
3. Redis cache is invalidated immediately — next fee calculation picks up the new strategy.
4. On Friday, `calculateFee({ amount, evaluationTime: new Date() })` resolves the time_based strategy first (priority 10 < 100), checks `daysOfWeek: [5]`, matches, and returns `fee: 0`.
5. On other days, the time_based strategy's condition fails and the engine falls through to the standard 1.5% strategy.
6. To end the campaign: `POST /api/fee-strategies/:id/deactivate` — takes effect within 60 seconds (cache TTL).

---

## Caching

- Active strategies are cached in Redis under `fee_strategies:resolved:<userId>:<provider>`.
- TTL: **60 seconds** — short enough for near-real-time updates, long enough to protect the DB.
- Any write operation (create/update/delete/activate/deactivate) immediately invalidates all `fee_strategies:*` keys.

---

## Database Migration

Run the migration to create the required tables:

```bash
npm run migrate:up
```

Migration file: `migrations/20260424_create_fee_strategies.sql`

Tables created:

- `fee_strategies` — strategy definitions
- `fee_strategy_audit` — full audit trail of all changes

---

## Design Decisions

**Why Strategy Pattern?**
Each fee type is a pure function with a well-defined interface. Adding a new strategy type (e.g. `referral_based`) requires only adding a new case to `applyStrategy()` — no changes to the resolution logic.

**Why not replace the existing FeeService?**
The existing `FeeService` + VIP tier system is preserved for backward compatibility. The strategy engine is additive — it runs alongside the existing system and can be adopted incrementally.

**Why 60s cache TTL instead of 1 hour?**
The existing fee config cache uses 1 hour. For a strategy engine that marketing teams update live, 60 seconds is a better tradeoff between latency and DB load. Cache is also explicitly invalidated on every write.

**Why store `evaluationTime` as a parameter?**
This makes time-based strategies fully testable without mocking `Date.now()`. The `/calculate` endpoint accepts an optional `evaluationTime` so QA can verify Friday promotions on any day.
