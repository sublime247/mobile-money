# Mobile Money ↔ Stellar Bridge

[![CI](https://github.com/sublime247/mobile-money/actions/workflows/ci.yml/badge.svg)](https://github.com/sublime247/mobile-money/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A backend service that bridges African mobile money providers (MTN MoMo, Airtel Money, Orange Money) with the [Stellar](https://stellar.org) blockchain network — enabling low-cost cross-border payments and remittances across Africa and beyond.

## 🌟 The Problem

Sending money across African borders is expensive and slow. Traditional remittance services charge 7–10% in fees and take hours to days. Meanwhile, **500+ million people** across Africa already use mobile money for everyday transactions — but mobile money stops at the border.

## 💡 The Solution

This platform connects mobile money wallets to the Stellar blockchain, allowing users to:

1. **Deposit** mobile money (XAF) → receive Stellar tokens (XLM, USDC)
2. **Transfer** tokens across Stellar's network in ~5 seconds, for fractions of a cent
3. **Withdraw** Stellar tokens → receive mobile money in the destination country

The sender and recipient interact with their familiar mobile money apps. Stellar handles the cross-border settlement invisibly.

```mermaid
flowchart LR
    subgraph Source["📱 Source Mobile Money"]
        MTN["MTN MoMo<br/>Cameroon"]
        AirtelSrc["Airtel Money<br/>Nigeria"]
        OrangeSrc["Orange Money<br/>Senegal"]
    end

    subgraph Bridge["🌉 Mobile Money ↔ Stellar Bridge"]
        API["REST / GraphQL API"]
        MM["Mobile Money Service<br/>(debit / credit)"]
        Ledger["Double-Entry Ledger"]
        Fee["Dynamic Fee Engine"]
        Queue["BullMQ Job Queue<br/>+ Redis"]
        Vault["Vault System"]
    end

    subgraph Stellar["💫 Stellar Network"]
        Horizon["Horizon API"]
        Assets["Assets<br/>XLM · USDC · Custom"]
        Soroban["Soroban Smart Contracts<br/>Escrow · HTLC"]
    end

    subgraph Dest["📱 Destination Mobile Money"]
        AirtelDst["Airtel Money<br/>Kenya"]
        Mpesa["M-Pesa<br/>Kenya"]
        OrangeDst["Orange Money<br/>Madagascar"]
    end

    MTN -->|"1. Deposit XAF"| API
    AirtelSrc -->|"1. Deposit NGN"| API
    OrangeSrc -->|"1. Deposit XOF"| API

    API -->|"2. Validate / Auth"| MM
    MM -->|"3. Debit wallet"| MTN
    MM -->|"3. Debit wallet"| AirtelSrc
    MM -->|"3. Debit wallet"| OrangeSrc
    MM -->|"4. Record tx"| Ledger
    Ledger -->|"5. Apply fees"| Fee
    Ledger -->|"6. Secure funds"| Vault

    Ledger -->|"7. Mint / swap tokens"| Queue
    Queue -->|"8. Submit tx (~5s)"| Horizon
    Horizon -->|"9. Issue assets"| Assets
    Horizon <-->|"10. Escrow/HTLC"| Soroban

    Assets -->|"11. Burn / lock tokens"| Queue
    Queue -->|"12. Credit payout"| MM
    MM -->|"13. Credit wallet"| AirtelDst
    MM -->|"13. Credit wallet"| Mpesa
    MM -->|"13. Credit wallet"| OrangeDst

    style Bridge fill:#e0f2fe,stroke:#0369a1,stroke-width:2px
    style Stellar fill:#ede9fe,stroke:#7c3aed,stroke-width:2px
    style Source fill:#fef3c7,stroke:#d97706,stroke-width:2px
    style Dest fill:#dcfce7,stroke:#16a34a,stroke-width:2px
```

### Use Cases

* **Remittances** — Send money home across borders at ~1–2% vs 7–10% with traditional services
* **Cross-border B2B payments** — Pay suppliers in other African countries without expensive wire transfers
* **Stable savings** — Convert volatile local currency to USDC via mobile money
* **Merchant payments** — Accept crypto, settle in local mobile money
* **Developer integrations** — Build payment apps on top of our REST + GraphQL APIs

## 🚀 Key Features

### Core Platform

* **Mobile Money Integration** — MTN MoMo, Airtel Money, Orange Money with circuit breaker, failover, and batch payouts
* **Stellar Blockchain** — XLM, USDC, and custom asset support via Stellar SDK + Horizon API
* **Dual API** — REST (40+ endpoints) and GraphQL (queries, mutations, and real-time subscriptions)
* **Real-time Processing** — BullMQ job queues with Redis, admin dashboard at `/admin/queues`
* **WebSocket** — Live transaction updates with JWT auth, per-user rooms, and Redis pub/sub for horizontal scaling
* **Provider Mock Server** — Full mock for MTN + Airtel APIs for local development without real credentials

### Security & Compliance

* **Multi-tier KYC** — Tiered identity verification with document upload (S3) and third-party verification (Entrust)
* **AML Monitoring** — Auto-flagging of suspicious patterns (large transactions, rapid structuring, daily totals)
* **Travel Rule Compliance** — FATF travel rule data collection for qualifying transactions
* **GDPR / Privacy** — Data export, deletion, and consent management endpoints
* **Sanctions Screening** — Automated screening against sanctions lists
* **2FA (TOTP)** — Time-based one-time passwords via Speakeasy, required for withdrawals
* **RBAC** — Role-based access control via Casbin
* **Rate Limiting & Audit Logging** — Multi-layer rate limiting with full audit trail
* **PII Encryption** — AES-256-GCM encryption for sensitive data at rest

### Financial Engine

* **Dynamic Fee Engine** — Configurable fee strategies with VIP tiers (25KB+ fee strategy engine)
* **Transaction Limits** — Provider-specific and KYC-tiered daily limits
* **Vault System** — Secure fund storage with distributed locking
* **Double-Entry Ledger** — Internal accounting system with full transaction journal
* **Dispute Management** — Complete dispute workflow with state machine
* **Monthly Statements** — Automated PDF statement generation
* **Reconciliation** — Provider reconciliation workflows

### Stellar Protocol (SEP) Support

* **SEP-06** — Deposit and Withdrawal API
* **SEP-10** — Web Authentication (challenge-response)
* **SEP-12** — KYC API (customer CRUD with document upload)
* **SEP-24** — Interactive Deposit and Withdrawal (hosted flow)
* **SEP-31** — Cross-Border Payments (send-side anchor)

### Smart Contracts

* **Escrow Contract** — Soroban smart contract for escrowed payments (Rust)
* **HTLC Contract** — Hash Time-Locked Contract for atomic cross-chain swaps (Rust)

### Notifications

* **Email** — SendGrid integration
* **SMS** — Twilio integration
* **Push Notifications** — Firebase Cloud Messaging
* **WhatsApp** — Twilio WhatsApp channel
* **PagerDuty** — Operational alerting

### Developer Tools

* **CLI** (`momo-cli`) — Admin tool for auth, status checks, and transaction retries
* **Kotlin SDK** — Auto-generated from OpenAPI spec
* **Postman Collections** — Pre-built API collections for testing
* **VS Code Extension** — Transaction monitor with live WebSocket logs
* **Swagger UI** — Auto-generated from Zod schemas at `/docs` (dev mode)

## 📋 Prerequisites

* Node.js 20+ (LTS)
* PostgreSQL 16+
* Redis 7+
* Docker (optional, recommended for local dev)

## 🛠️ Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/sublime247/mobile-money.git
cd mobile-money
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your configuration (see `.env.example` for all ~470 configuration options):

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/mobilemoney

# Redis
REDIS_URL=redis://localhost:6379

# Stellar
STELLAR_NETWORK=testnet  # or 'mainnet'
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_ISSUER_SECRET=S...

# Mobile Money Providers
MTN_API_KEY=your_mtn_api_key
AIRTEL_API_KEY=your_airtel_key
ORANGE_API_KEY=your_orange_key

# Security
JWT_SECRET=your_jwt_secret_min_32_chars
SESSION_SECRET=your_session_secret

# Optional: Notifications
SENDGRID_API_KEY=your_sendgrid_key
TWILIO_ACCOUNT_SID=your_twilio_sid
```

> Don't hand-type placeholder secrets. See [Generating Keys and Secrets](#generating-keys-and-secrets) for copy-paste `node` commands that generate real values for `JWT_SECRET`, `ADMIN_API_KEY`, `DB_ENCRYPTION_KEY`, and `PII_MASTER_KEY`.

### 3. Setup Database

```bash
npm run migrate:up
npm run seed  # Optional: development data
```

### 4. Run

**Development (with provider mocks):**

```bash
npm run docker:dev   # Starts app + Postgres + Redis + provider mock server
```

**Development (standalone):**

```bash
npm run dev
```

**Production:**

```bash
npm run build
npm start
```

Server starts at `http://localhost:3000`

## 🐳 Local Docker Environment

This project ships with two Docker Compose configurations for local development. Both start the full application stack — no external services required.

### Compose Files

| File                     | Purpose                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `docker-compose.yml`     | Full stack with hot-reload, Loki/Grafana logging, and a local Stellar node      |
| `docker-compose.dev.yml` | Lightweight dev stack — mounts source directly and enables the Node.js debugger |

### Services

`docker-compose.yml` starts the following containers:

| Container                        | Image                       | Exposed Ports                                    | Purpose                  |
| -------------------------------- | --------------------------- | ------------------------------------------------ | ------------------------ |
| `mobilemoney_app`                | Built from `Dockerfile.dev` | `3000`                                           | API server (hot-reload)  |
| `mobilemoney_postgres`           | `postgres:16-alpine`        | —                                                | Primary database         |
| `mobilemoney_redis`              | `redis:7-alpine`            | —                                                | Cache, sessions, queues  |
| `mobilemoney_maildev`            | `maildev/maildev:2.1.0`     | `1080` (UI), `1025` (SMTP)                       | Local email capture      |
| `mobilemoney_stellar_quickstart` | `stellar/quickstart:latest` | `8000` (Horizon/Friendbot), `8001` (Soroban RPC) | Local Stellar node       |
| `mobilemoney_loki`               | `grafana/loki:latest`       | `3100`                                           | Log aggregation          |
| `mobilemoney_promtail`           | `grafana/promtail:latest`   | —                                                | Log shipper              |
| `mobilemoney_grafana`            | `grafana/grafana:latest`    | `3001`                                           | Metrics & log dashboards |

`docker-compose.dev.yml` starts a slimmer set: `app`, `db`, `redis`, `maildev`, and `stellar` — with the Node.js inspector exposed on port `9229` for debugger attachment.

### Running the Containers

```bash
# Start all services (foreground — streams all logs to your terminal)
docker compose up

# Start all services in the background
docker compose up -d

# Start only specific services
docker compose up app postgres redis

# Start the lightweight dev stack (with debugger)
docker compose -f docker-compose.dev.yml up

# Stop all containers (preserves volumes)
docker compose down

# Stop and delete all data volumes (fresh database)
docker compose down -v

# Rebuild the app image after Dockerfile changes
docker compose up --build
```

> **First run:** the app waits for Postgres and Redis health checks to pass before starting, so the initial boot takes ~15–30 seconds.

### Tracking Logs

**Stream all logs:**

```bash
docker compose logs -f
```

**Stream logs for a single service:**

```bash
docker compose logs -f app
docker compose logs -f postgres
docker compose logs -f redis
```

**Show the last N lines and follow:**

```bash
docker compose logs --tail=100 -f app
```

**View logs from a one-off container by name:**

```bash
docker logs mobilemoney_app -f
```

**Grafana / Loki (structured log explorer):**

1. Open `http://localhost:3001` in your browser (credentials: `admin` / `admin`).
2. Navigate to **Explore** → select the **Loki** data source.
3. Query by service name, e.g. `{service_name="mobile-money-api"}`.
4. Filter by log level: `{service_name="mobile-money-api"} | json | level="error"`.

**Captured emails (Maildev UI):**

Open `http://localhost:1080` to inspect emails sent by the application during development.

### Useful Container Commands

```bash
# Open a shell inside the running app container
docker compose exec app sh

# Run database migrations inside the container
docker compose exec app npm run migrate:up

# Seed development data
docker compose exec app npm run seed

# Check the Stellar local node (Friendbot / faucet)
curl http://localhost:8000/friendbot?addr=<STELLAR_PUBLIC_KEY>

# Inspect Redis keys
docker compose exec redis redis-cli keys "*"
```

### Environment Variables

The compose files pre-configure `DATABASE_URL` and `REDIS_URL` to point at the containerised services, so you do not need to change those in `.env` for local development. All other variables (API keys, `JWT_SECRET`, etc.) are still read from your `.env` file via `env_file`.

## 🧪 Testing

```bash
npm test                    # Unit tests (Jest)
npm run test:coverage       # With coverage report
npm run test:watch          # Watch mode
npm run test:e2e            # End-to-end (Playwright)
npm run test:load           # Load testing (k6 / autocannon)
npm run test:mutation       # Mutation testing (Stryker)
```

**Test infrastructure includes:**

* Unit & integration tests across controllers, services, middleware, routes
* Pact consumer-driven contract tests for provider APIs
* Playwright end-to-end tests
* k6 load/stress tests with benchmarking against Go vs Node ingest services
* Stryker mutation testing
* Fuzz testing

## 📚 API Documentation

### Interactive Docs (Development Only)

Start the dev server and visit:

* **Swagger UI**: `http://localhost:3000/docs`
* **OpenAPI JSON**: `http://localhost:3000/docs/openapi.json`

The API spec is auto-generated from Zod validation schemas at runtime — no manual YAML to maintain.

### Core Endpoints

```bash
# Health
GET  /health                          # Liveness probe
GET  /ready                           # Readiness (DB + Redis)
GET  /health/lb                       # Load balancer health

# Transactions
POST /api/transactions/deposit        # Mobile money → Stellar
POST /api/transactions/withdraw       # Stellar → Mobile money
GET  /api/transactions                # List (paginated, filterable)
GET  /api/transactions/:id            # Transaction details
GET  /api/transactions/:id/invoice    # Download completed transaction invoice
POST /api/transactions/:id/cancel     # Cancel pending transaction
POST /api/transactions/:id/dispute    # Open dispute
POST /api/transactions/bulk           # Bulk operations

# Auth
POST /api/auth/register               # Register
POST /api/auth/login                  # Login (returns JWT)
POST /api/auth/2fa/enable             # Enable TOTP 2FA
POST /oauth/token                     # OAuth2 client credentials

# KYC
POST /api/kyc/submit                  # Submit documents
GET  /api/kyc/status                  # Check verification status

# Vaults
POST /api/vaults                      # Create vault
GET  /api/vaults                      # List vaults
POST /api/vaults/:id/transfer         # Deposit/withdraw funds

# Disputes
GET  /api/disputes                    # List disputes
PUT  /api/disputes/:id                # Update dispute status

# Compliance
GET  /api/v1/compliance/travel-rule   # Travel rule data
GET  /api/gdpr/export                 # GDPR data export
DELETE /api/gdpr/delete               # Right to be forgotten

# Stellar SEP Endpoints
POST /sep10/auth                      # SEP-10 authentication
GET  /sep12/customer                  # SEP-12 KYC
POST /sep24/transactions/deposit/interactive  # SEP-24 deposit
POST /sep31/transactions              # SEP-31 cross-border

# Admin
GET  /api/admin/*                     # Admin dashboard endpoints
GET  /api/stats                       # Transaction statistics
GET  /api/reconciliation              # Provider reconciliation
GET  /metrics                         # Prometheus metrics
```

### GraphQL

```bash
POST /graphql
```

Playground: `http://localhost:3000/graphql` (dev only)

```graphql
# Query transactions
query {
  transactions(limit: 10) {
    id
    amount
    status
    provider
  }
}

# Create a deposit
mutation {
  createDeposit(
    input: { amount: "10000", phoneNumber: "+237670000000", provider: MTN }
  ) {
    id
    status
  }
}

# Real-time subscription
subscription {
  transactionUpdated(userId: "user-123") {
    id
    status
    updatedAt
  }
}
```

### Authentication

Most endpoints require JWT:

```bash
Authorization: Bearer <token>
```

Admin operations use API key:

```bash
X-API-Key: <key>
```

## 🔐 Security

### Transaction Limits

| Type    | Limit         | Purpose          |
| ------- | ------------- | ---------------- |
| Minimum | 100 XAF       | Prevent spam     |
| Maximum | 1,000,000 XAF | Fraud prevention |

### KYC-Based Daily Limits

| Level      | Daily Limit   | Requirements             |
| ---------- | ------------- | ------------------------ |
| Unverified | 10,000 XAF    | Email only               |
| Basic      | 100,000 XAF   | ID + selfie              |
| Full       | 1,000,000 XAF | Proof of address + video |

### Provider Limits

| Provider | Min     | Max           |
| -------- | ------- | ------------- |
| MTN      | 100 XAF | 500,000 XAF   |
| Airtel   | 100 XAF | 1,000,000 XAF |
| Orange   | 500 XAF | 750,000 XAF   |

### AML Monitoring

Auto-flagging of suspicious transactions:

* Single transaction > 1,000,000 XAF
* 24h total > 5,000,000 XAF
* Rapid structuring (3+ mixed in 15 min)
* Sanctions list screening on every transaction

<a id="generating-keys-and-secrets"></a>

## 🔑 Generating Keys and Secrets

Every secret in the `# Security` block of `.env.example` needs a real, high-entropy value before you run the app outside of local development. The snippets below use Node's built-in `crypto` module — no extra dependencies — and match how each key is consumed in code.

### JWT Signing Keys

JWTs are signed with `JWT_SECRET` (see [`src/auth/jwtKeys.ts`](src/auth/jwtKeys.ts)). Generate a 256-bit secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output into `.env`:

```bash
JWT_SECRET=<paste-generated-value-here>
```

For zero-downtime key rotation, the app also accepts a versioned `JWT_SECRETS` map plus an `ACTIVE_JWT_KEY_VERSION` pointer. Old versions stay valid for a 24-hour grace period so in-flight tokens don't break:

```bash
# Generate a second key the same way, then:
JWT_SECRETS={"v1":"<existing-key>","v2":"<new-generated-key>"}
ACTIVE_JWT_KEY_VERSION=v2
```

### Admin API Key

Administrative endpoints accept a static key via the `X-API-Key` header, checked against `ADMIN_API_KEY` (see [`src/middleware/auth.ts`](src/middleware/auth.ts)). It's generated the same way user-scoped API keys are created in [`src/auth/apikeys.ts`](src/auth/apikeys.ts):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
ADMIN_API_KEY=<paste-generated-value-here>
```

The `.env.example` default (`dev-admin-key`) is for local development only — always replace it before deploying anywhere reachable outside your machine.

### Database Encryption Keys

PII fields (phone numbers, Stellar addresses, notes) are encrypted at rest with AES-256-GCM. The raw values of `DB_ENCRYPTION_KEY` and `PII_MASTER_KEY` aren't used directly as AES keys — they're key material fed through HKDF-SHA-256 to derive the actual per-field keys (see [`src/utils/encryption.ts`](src/utils/encryption.ts)). Any high-entropy string works; a random hex string is the simplest way to get one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate **two separate values** — `PII_MASTER_KEY` must never equal `DB_ENCRYPTION_KEY`:

```bash
DB_ENCRYPTION_KEY=<paste-first-generated-value-here>
PII_MASTER_KEY=<paste-second-generated-value-here>
```

For rotating an in-use encryption key without re-encrypting existing rows immediately, the app also supports a versioned `DB_ENCRYPTION_KEYS` JSON map (or individual `DB_ENCRYPTION_KEY_<VERSION>` variables) with an `ACTIVE_ENCRYPTION_KEY_VERSION` pointer, mirroring the JWT rotation pattern above.

> **Never commit generated secrets to version control**, log them, or paste them into chat/tickets. Store production values in your secrets manager (see [`docs/SECRETS_MANAGEMENT.md`](docs/SECRETS_MANAGEMENT.md)) and inject them as environment variables at deploy time.

## 🏗️ Architecture

### Data Flow Overview

This diagram maps the end-to-end data movement across mobile money providers, the bridge service, and the Stellar network for both deposit and withdrawal flows.

```mermaid
flowchart TB
    subgraph UserLayer["👤 User Layer"]
        Sender["Sender<br/>(Mobile Money App)"]
        Recipient["Recipient<br/>(Mobile Money App)"]
    end

    subgraph ProviderLayer["📡 Mobile Money Providers"]
        direction LR
        MTN["MTN MoMo API"]
        Airtel["Airtel Money API"]
        Orange["Orange Money API"]
    end

    subgraph BridgeLayer["🌉 Bridge Service Layer"]
        direction TB
        subgraph APISub["API Gateway"]
            REST["REST API<br/>(40+ endpoints)"]
            GraphQL["GraphQL API<br/>(queries + subscriptions)"]
            WS["WebSocket<br/>(live updates)"]
        end

        subgraph MiddlewareSub["Middleware Pipeline"]
            Auth["Auth (JWT / 2FA)"]
            RBAC["RBAC (Casbin)"]
            RateLimit["Rate Limiting"]
            AML["AML / Sanctions Check"]
            Audit["Audit Logging"]
        end

        subgraph ServicesSub["Core Services"]
            TxService["Transaction Service"]
            MMSvc["Mobile Money Service<br/>(circuit breaker + failover)"]
            StellarSvc["Stellar Service<br/>(SDK + Horizon)"]
            FeeSvc["Fee Engine<br/>(VIP tiers + strategies)"]
            LedgerSvc["Double-Entry Ledger"]
            VaultSvc["Vault / Liquidity Mgmt"]
        end

        subgraph DataSub["Data & Processing"]
            PG[("PostgreSQL 16<br/>+ read replicas")]
            RD[("Redis 7<br/>cache / pub/sub")]
            BQ["BullMQ Queues<br/>+ Workers"]
        end

        subgraph ComplianceSub["Compliance & Security"]
            KYC["Multi-tier KYC<br/>(Entrust + S3)"]
            Travel["FATF Travel Rule"]
            Dispute["Dispute Mgmt<br/>(State Machine)"]
        end
    end

    subgraph StellarLayer["💫 Stellar Network Layer"]
        direction LR
        Horizon["Horizon API<br/>(testnet / mainnet)"]
        Assets["Assets<br/>XLM · USDC · Custom"]
        Soroban["Soroban Smart Contracts<br/>Escrow · HTLC · Swap Router"]
        StellarCore["Stellar Core Nodes<br/>(consensus ~5s)"]
    end

    %% ======== DEPOSIT FLOW (Mobile Money → Stellar) ========
    Sender -->|"D1. Initiate deposit<br/>via USSD / App"| MTN
    Sender -->|"D1. Initiate deposit"| Airtel
    Sender -->|"D1. Initiate deposit"| Orange

    MTN -->|"D2. Callback / Poll"| REST
    Airtel -->|"D2. Callback / Poll"| REST
    Orange -->|"D2. Callback / Poll"| REST

    REST -->|"D3. Route request"| Auth
    Auth -->|"D4. Verify identity"| KYC
    Auth --> RBAC
    RBAC --> RateLimit
    RateLimit --> AML
    AML -->|"D5. Screen sanctions"| PG
    AML --> Audit

    Audit -->|"D6. Create transaction"| TxService
    TxService -->|"D7. Debit wallet (async)"| BQ
    BQ -->|"D8. Provider request"| MMSvc
    MMSvc -->|"D9. requestPayment()"| MTN
    MMSvc -->|"D9. requestPayment()"| Airtel
    MMSvc -->|"D9. requestPayment()"| Orange

    MTN -->|"D10. Debit success"| MMSvc
    Airtel -->|"D10. Debit success"| MMSvc
    Orange -->|"D10. Debit success"| MMSvc

    MMSvc -->|"D11. Confirm debit"| TxService
    TxService -->|"D12. Apply fee"| FeeSvc
    TxService -->|"D13. Ledger entries"| LedgerSvc
    LedgerSvc -->|"D14. Journal → DB"| PG
    LedgerSvc -->|"D15. Lock funds"| VaultSvc
    VaultSvc --> PG

    TxService -->|"D16. Enqueue mint"| BQ
    BQ -->|"D17. Worker: build tx"| StellarSvc
    StellarSvc -->|"D18. Build + sign tx"| Horizon
    Horizon -->|"D19. Submit to network"| StellarCore
    StellarCore -->|"D20. Consensus ✔︎"| Horizon
    Horizon -->|"D21. Credit assets"| Assets
    StellarSvc <-->|"D22. Escrow if needed"| Soroban

    StellarSvc -->|"D23. Update status"| TxService
    TxService -->|"D24. Notify via WS/SMS/Email"| WS
    TxService --> PG
    WS --> Sender

    %% ======== WITHDRAWAL FLOW (Stellar → Mobile Money) ========
    Recipient -->|"W1. Receive notification"| WS

    Sender -->|"W2. Initiate withdraw<br/>from Stellar"| GraphQL
    GraphQL --> Auth
    Auth -->|"W3. 2FA required"| RBAC
    RBAC --> RateLimit
    RateLimit --> AML
    AML --> Audit

    Audit -->|"W4. Create withdraw tx"| TxService
    TxService -->|"W5. Check KYC tier"| KYC
    KYC --> PG

    TxService -->|"W6. Enqueue burn"| BQ
    BQ -->|"W7. Worker: burn/lock"| StellarSvc
    StellarSvc -->|"W8. Submit burn tx"| Horizon
    Horizon --> StellarCore
    StellarCore -->|"W9. Burn / lock assets"| Assets
    StellarSvc -->|"W10. Escrow release"| Soroban

    StellarSvc -->|"W11. Confirm on-chain"| TxService
    TxService -->|"W12. Ledger entries"| LedgerSvc
    LedgerSvc -->|"W13. Unlock funds"| VaultSvc
    LedgerSvc --> PG

    TxService -->|"W14. Enqueue payout"| BQ
    BQ -->|"W15. Worker: payout"| MMSvc
    MMSvc -->|"W16. sendPayout()"| MTN
    MMSvc -->|"W16. sendPayout()"| Airtel
    MMSvc -->|"W16. sendPayout()"| Orange

    MTN -->|"W17. Credit wallet"| Recipient
    Airtel -->|"W17. Credit wallet"| Recipient
    Orange -->|"W17. Credit wallet"| Recipient

    MTN -->|"W18. Payout confirm"| MMSvc
    Airtel -->|"W18. Payout confirm"| MMSvc
    Orange -->|"W18. Payout confirm"| MMSvc

    MMSvc -->|"W19. Reconcile"| TxService
    TxService --> PG
    TxService -->|"W20. Notify recipient"| WS

    %% Styling
    style UserLayer fill:#fff7ed,stroke:#c2410c,stroke-width:2px
    style ProviderLayer fill:#fef3c7,stroke:#d97706,stroke-width:2px
    style BridgeLayer fill:#e0f2fe,stroke:#0369a1,stroke-width:2px
    style StellarLayer fill:#ede9fe,stroke:#7c3aed,stroke-width:2px

    style APISub fill:#dbeafe,stroke:#2563eb,stroke-width:1px
    style MiddlewareSub fill:#fce7f3,stroke:#be185d,stroke-width:1px
    style ServicesSub fill:#d1fae5,stroke:#047857,stroke-width:1px
    style DataSub fill:#f3e8ff,stroke:#6d28d9,stroke-width:1px
    style ComplianceSub fill:#fee2e2,stroke:#b91c1c,stroke-width:1px
```

### Deposit → Withdrawal End-to-End Sequence

```mermaid
sequenceDiagram
    actor Sender
    participant MM as Mobile Money Provider
    participant API as Bridge API
    participant MMsvc as Mobile Money Svc
    participant Ledger as Ledger Service
    participant Queue as BullMQ Worker
    participant Stellar as Stellar Service
    participant HZN as Horizon / Stellar

    Note over Sender,HZN: 📥 DEPOSIT: Mobile Money → Stellar
    Sender->>MM: 1. Initiate deposit (USSD/App)
    MM-->>API: 2. Callback / webhook
    API->>API: 3. Auth + AML + Sanctions
    API->>MMsvc: 4. requestPayment(debit)
    MMsvc->>MM: 5. Debit sender wallet
    MM-->>MMsvc: 6. Debit confirmed
    MMsvc->>Ledger: 7. Record + apply fees
    Ledger->>Ledger: 8. Vault lock + journal entries
    Ledger->>Queue: 9. Enqueue token mint job
    Queue->>Stellar: 10. Build + sign Stellar tx
    Stellar->>HZN: 11. Submit (payment / changeTrust)
    HZN-->>Stellar: 12. ✅ On-chain (~5s)
    Stellar->>API: 13. Update tx status → completed
    API-->>Sender: 14. WebSocket + SMS + Email

    Note over Sender,HZN: 📤 WITHDRAWAL: Stellar → Mobile Money
    Sender->>API: 15. POST /transactions/withdraw
    API->>API: 16. JWT + 2FA + KYC tier check
    API->>Queue: 17. Enqueue burn + payout jobs
    Queue->>Stellar: 18. Burn / escrow tokens
    Stellar->>HZN: 19. Submit burn tx
    HZN-->>Stellar: 20. ✅ Burn confirmed
    Stellar->>Ledger: 21. Unlock vault funds
    Ledger->>Queue: 22. Enqueue payout job
    Queue->>MMsvc: 23. sendPayout(credit)
    MMsvc->>MM: 24. Credit recipient wallet
    MM-->>MMsvc: 25. Payout confirmed
    MMsvc->>API: 26. Reconcile + status
    API-->>Sender: 27. Notify recipient + sender
```

### Tech Stack

| Layer                        | Technology                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------- |
| **API Server**               | Node.js, TypeScript, Express, Apollo Server (GraphQL)                            |
| **Database**                 | PostgreSQL 16 (primary + read replicas), Redis 7 (cache, sessions, pub/sub)      |
| **Blockchain**               | Stellar SDK, Horizon API, Soroban smart contracts (Rust)                         |
| **Job Processing**           | BullMQ workers, node-cron scheduled jobs                                         |
| **Ingest (High-throughput)** | Go service (fasthttp) + Node.js service (Fastify), Redis Streams, NATS JetStream |
| **Security**                 | Helmet, bcrypt, JWT, Speakeasy (TOTP), Casbin (RBAC), AES-256-GCM (PII)          |
| **Monitoring**               | Prometheus, Datadog (dd-trace), Sentry, PagerDuty                                |
| **Logging**                  | Structured JSON → Loki/Grafana (primary), ELK stack (secondary)                  |
| **Edge**                     | Cloudflare Workers (`.well-known` caching)                                       |
| **Infrastructure**           | Docker, Kubernetes (+ Helm, KEDA), Terraform (AWS)                               |
| **CI/CD**                    | GitHub Actions (lint, test, build, deploy, rollback)                             |

### Project Structure

```
mobile-money/
├── src/
│   ├── auth/              # Authentication & authorization
│   ├── compliance/        # Travel rule, sanctions
│   ├── config/            # Centralized configuration
│   ├── constants/         # Error codes, enums
│   ├── controllers/       # Request handlers
│   ├── crypto/            # Encryption utilities
│   ├── graphql/           # Schema, resolvers, subscriptions, APQ cache
│   ├── jobs/              # Scheduled & background jobs
│   ├── locales/           # i18n translations
│   ├── middleware/        # Auth, RBAC, rate limiting, audit, error handling
│   ├── models/            # Database models (15 models)
│   ├── openapi/           # Auto-generated API docs (Zod → OpenAPI)
│   ├── queue/             # BullMQ job queue management
│   ├── reports/           # Statement & report generation
│   ├── routes/            # API routes (40+ route files, versioned)
│   ├── services/          # Business logic (58 service files)
│   │   ├── mobilemoney/   # MTN, Airtel, Orange providers + orchestration
│   │   └── stellar/       # Stellar operations, asset management, HSM
│   ├── stellar/           # SEP protocol implementations (6, 10, 12, 24, 31)
│   ├── types/             # TypeScript type definitions
│   ├── utils/             # Helpers & utilities
│   └── websocket/         # WebSocket server (JWT auth, Redis scaling)
├── contracts/             # Soroban smart contracts (Escrow, HTLC)
├── ingest-go/             # High-performance Go callback ingestion
├── ingest-node/           # Node.js baseline for benchmarking
├── workers/               # Cloudflare Workers (edge caching)
├── cli/                   # CLI admin tool (momo-cli)
├── sdk/                   # Auto-generated Kotlin SDK
├── benchmarks/            # k6 load testing suite
├── bridge-starter-node/   # Webhook bridge starter template
├── docs/                  # Extensive documentation (59 docs)
├── docs-portal/           # Docusaurus documentation site
├── extensions/            # VS Code transaction monitor extension
├── postman/               # API testing collections
├── migrations/            # Database migrations (47 migrations)
├── k8s/                   # Kubernetes manifests + Helm chart
├── terraform/             # AWS infrastructure (VPC, ECS, RDS, ElastiCache)
├── elk/                   # ELK stack config (Filebeat, Logstash, Kibana)
├── logging/               # Loki + Grafana + Promtail config
├── scripts/               # Operational scripts (mock server, DB scrub, etc.)
└── tests/                 # Test suites (unit, integration, e2e, pact, fuzz)
```

## 🔄 Database

### Migrations

47 migration files covering the full schema — transactions (partitioned), users, disputes, vaults, ledger (double-entry), webhooks, KYC, AML alerts, compliance documents, fee strategies, and more.

```bash
npm run migrate:create -- migration_name  # Create
npm run migrate:up                        # Run all pending
npm run migrate:down                      # Rollback last
npm run migrate:status                    # Check status
```

### Read Replica Routing

HTTP method-based routing: `GET`/`HEAD`/`OPTIONS` → read replicas (round-robin), write operations → primary. Automatic fallback to primary if replicas are unavailable.

## 📊 Monitoring & Observability

### Metrics

Prometheus metrics at `/metrics`:

* Transaction counts by status and provider
* API response times (histograms)
* Queue depths and job latencies
* Error rates by category
* Provider availability and circuit breaker state

### Health Checks

```bash
curl http://localhost:3000/health     # Liveness
curl http://localhost:3000/ready      # Readiness (DB + Redis)
curl http://localhost:3000/health/lb  # Load balancer
```

### Logging

Dual logging stack:

* **Primary**: Structured JSON → Loki → Grafana (included in docker-compose)
* **Secondary**: Filebeat → Logstash → Elasticsearch → Kibana (ELK stack configs in `elk/`)

### Alerting

* **Sentry** — Error tracking and exception monitoring
* **Datadog** — APM tracing (dd-trace)
* **PagerDuty** — Operational alerts (low liquidity, provider outages)

## 🚢 Deployment

### Docker

```bash
# Development (with mocks, hot reload, Grafana)
docker compose up

# Production build
docker build -t mobile-money:latest .
docker run -p 3000:3000 --env-file .env mobile-money:latest
```

The production Dockerfile uses a multi-stage build targeting < 200MB image size with a non-root user.

### Kubernetes

Pre-built manifests in `k8s/` include:

* **Deployment** — 3 replicas, rolling updates, startup/liveness/readiness probes, resource limits
* **Worker Deployment** — Separate BullMQ worker pods
* **KEDA Autoscaling** — Scale workers based on queue depth (threshold: 20 jobs, 1–20 replicas)
* **HPA** — CPU-based horizontal pod autoscaling for the API
* **PodDisruptionBudget** — Minimum 2 available pods during disruptions
* **Helm Chart** — Parameterized deployment in `k8s/helm/`

```bash
kubectl apply -f k8s/
```

### Terraform (AWS)

Full AWS infrastructure in `terraform/`:

* VPC with public/private subnets across multiple AZs
* ECS Fargate for containerized deployment
* RDS PostgreSQL with Multi-AZ (production)
* ElastiCache Redis with failover
* Application Load Balancer

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan -var-file=environments/production.tfvars
terraform apply
```

### Render

Render deploys directly from GitHub and provisions Postgres/Redis as managed add-ons — a fast path for staging environments or small production deployments.

#### 1. Link the repository

1. Push your fork to GitHub (see [Contributing](#-contributing) for the fork workflow)
2. In the [Render Dashboard](https://dashboard.render.com), click **New → Web Service**
3. Choose **Build and deploy from a Git repository**, authorize GitHub, and select `mobile-money`
4. Pick the branch to deploy (typically `main`) — Render redeploys automatically on every push

#### 2. Provision the database and Redis

1. **New → PostgreSQL** → copy the generated **Internal Database URL**
2. **New → Key Value** (Render's managed Redis-compatible store) → copy the connection string

#### 3. Configure environment variables

Set these under the Web Service's **Environment** tab:

```bash
DATABASE_URL=<Render PostgreSQL Internal Database URL>
DATABASE_SSL=true

REDIS_URL=<Render Key Value connection string>
REDIS_TLS=true

STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_ISSUER_SECRET=S...

JWT_SECRET=your_jwt_secret_min_32_chars
SESSION_SECRET=your_session_secret
```

#### 4. Build, migrate, and deploy

* **Build Command**: `npm install && npm run build`
* **Start Command**: `npm start`
* **Pre-Deploy Command**: `npm run migrate:up`
* **Health Check Path**: `/health`

```bash
curl https://<your-service>.onrender.com/health
curl https://<your-service>.onrender.com/ready
```

### Railway

Railway offers a similarly GitHub-native deploy flow with one-click Postgres and Redis plugins.

#### 1. Link repository in Railway

1. In the [Railway Dashboard](https://railway.app/dashboard), click **New Project → Deploy from GitHub repo**
2. Authorize the Railway GitHub App and select `mobile-money`
3. Railway detects the Node.js app and auto-generates a build/start config (or use the CLI below)

```bash
npm install -g @railway/cli
railway login
railway link          # Link this directory to your Railway project
railway up            # Deploy the current branch
```

#### 2. Provision database and Redis in Railway

1. In the project canvas, click **New → Database → Add PostgreSQL**
2. Click **New → Database → Add Redis**
3. Railway automatically injects `DATABASE_URL` and `REDIS_URL` into your service's environment as reference variables

#### 3. Configure Railway environment variables

Under the service's **Variables** tab, add the remaining required config (Railway auto-fills `DATABASE_URL`/`REDIS_URL` from the plugins above):

```bash
DATABASE_SSL=true
REDIS_TLS=false   # Railway's internal Redis network doesn't require TLS

STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_ISSUER_SECRET=S...

JWT_SECRET=your_jwt_secret_min_32_chars
SESSION_SECRET=your_session_secret
```

#### 4. Build, migrate, and deploy in Railway

Railway runs `npm install` and `npm start` by default. To run migrations on each deploy, add a **Deploy Trigger** or **Release Command**:

```bash
railway run npm run migrate:up
```

Set the **Healthcheck Path** to `/health` under **Settings → Deploy** so Railway restarts the service on failed checks.

```bash
railway domain   # Generates a public URL
curl https://<your-service>.up.railway.app/health
```

### CI/CD

GitHub Actions pipeline (`.github/workflows/ci.yml`):

1. **Security** — npm audit, Snyk vulnerability scanning
2. **Test** — Lint, Jest (with Postgres + Redis services), Playwright E2E
3. **Build** — TypeScript compilation
4. **Docker** — Build and push image on main branch
5. **Deploy** — kubectl apply → rollout status → health check → auto-rollback on failure

## 🐛 Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for detailed error codes and solutions.

### Common Issues

**Database connection fails:**

```bash
pg_isready -h localhost -p 5432
# Verify DATABASE_URL format
```

**Redis connection fails:**

```bash
redis-cli ping  # Should return PONG
```

**Stellar transactions fail:**

```bash
echo $STELLAR_NETWORK  # Should be 'testnet' or 'mainnet'
curl https://horizon-testnet.stellar.org
```

**Provider mock not working:**

```bash
# Use docker-compose.dev.yml which includes the mock server
docker compose -f docker-compose.dev.yml up
```

## 🚨 Error Handling

Standardized error codes organized by category:

* **4000-4099**: Validation (HTTP 400)
* **4010-4019**: Authentication (HTTP 401)
* **4030-4039**: Authorization (HTTP 403)
* **4040-4049**: Not Found (HTTP 404)
* **4090-4099**: Conflict (HTTP 409)
* **4290-4299**: Rate Limit (HTTP 429)
* **5000+**: Server Errors (HTTP 500+)

See [src/constants/errorCodes.ts](src/constants/errorCodes.ts) for complete reference.

## 📖 Documentation

Extensive documentation is available in the [`docs/`](docs/) directory (59 documents), covering:

* **Architecture** — System design, Stellar-EVM bridge architecture, ZK balance proofs research
* **Features** — KYC, RBAC, GraphQL, SSO, transaction filtering, monthly statements, vaults
* **Stellar/SEP** — SEP-10/12/31 implementation guides, fee bumping, fee strategy engine
* **Infrastructure** — CI/CD pipeline, Docker dev setup, ELK stack, database backups, distributed locks
* **Integrations** — Bridge provider guides, Orange integration, Zapier/Make.com webhooks
* **Observability** — Metrics, slow query logging, PagerDuty, low liquidity alerts

A Docusaurus documentation portal is available in [`docs-portal/`](docs-portal/).

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md).

### Workflow

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Make changes and run tests (`npm test`)
4. Commit (`git commit -m 'Add amazing feature'`)
5. Push (`git push origin feature/amazing-feature`)
6. Open Pull Request

Pre-commit hooks run ESLint, Prettier, TypeScript checks, and tests automatically.

### Good First Issues

Check [`good first issue`](https://github.com/sublime247/mobile-money/labels/good%20first%20issue) label.

## 🛠️ API Integration Tooling (Postman & Bruno)

We provide turnkey API integration collections with pre-configured requests, test assertions, and automated SEP-10 challenge auto-signing.

### Postman Collection

The Postman collection is exported at [`postman/mobile-money-bridge.json`](postman/mobile-money-bridge.json).

#### How to Import

1. Open **Postman** and click **Import** (top left).
2. Drag and drop `postman/mobile-money-bridge.json` or choose **File** upload.
3. The collection **Mobile Money Bridge API** will be imported with 5 organized request folders:

   * **1. Auth**: SEP-10 challenge generation, automated pre-request challenge signing, JWT verification, and user profile.
   * **2. KYC**: SEP-12 customer data submission, status queries, and document uploads.
   * **3. Quotes**: SEP-38 price discovery, firm quote booking, and pre-flight fee calculation.
   * **4. Deposits**: SEP-24 interactive deposit initiation, status polling, and core mobile money collections.
   * **5. Withdrawals**: SEP-24 interactive withdrawal initiation, core mobile money disbursements, and transaction logs.

#### Environment Configuration

Set or override the following collection / environment variables:

* `base_url`: `http://localhost:3000` (or your deployed API gateway)
* `stellar_public_key`: Client Stellar public key (`G...`)
* `stellar_secret_key`: Client Stellar secret key (`S...`) used for auto-signing in pre-request script
* `home_domain`: Anchor domain name (e.g. `localhost:3000` or `stellarwave.io`)

### Bruno Collection

A native [Bruno](https://www.usebruno.com/) collection is available in [`postman/bruno/`](postman/bruno/):

1. In Bruno, click **Open Collection** and select the `postman/bruno` directory.
2. Select the **Local** environment located in `postman/bruno/environments/Local.bru`.
3. Run requests individually or run the complete test suite using the Bruno CLI:

   ```bash
   bru run --env Local
   ```

## 🗺️ Roadmap

* [ ] SEP-38 implementation (Quotes and Price Streams)
* [ ] Additional providers (Vodacom, Tigo, M-Pesa)
* [ ] Mobile SDKs (iOS, Android)
* [ ] Merchant dashboard UI
* [ ] Advanced analytics and reporting dashboard
* [ ] Multi-currency settlement support
* [ ] Additional stablecoin support (USDT, EURC)
* [ ] DeFi protocol integrations
* [ ] External accounting integrations (QuickBooks, Xero)

## 📝 License

MIT License — see [LICENSE](LICENSE) file.

## 🙏 Acknowledgments

* [Stellar Development Foundation](https://stellar.org)
* Mobile money providers (MTN, Airtel, Orange)
* Open source community

## 📞 Support

* **Issues**: [GitHub Issues](https://github.com/sublime247/mobile-money/issues)
* **Discussions**: [GitHub Discussions](https://github.com/sublime247/mobile-money/discussions)
* **Docs**: [Documentation Portal](docs-portal/)

---

Built with ❤️ for financial inclusion in Africa
