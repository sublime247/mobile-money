# Mobile Money ↔ Stellar Bridge

[![CI](https://github.com/sublime247/mobile-money/actions/workflows/ci.yml/badge.svg)](https://github.com/sublime247/mobile-money/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sublime247/mobile-money/branch/main/graph/badge.svg)](https://codecov.io/gh/sublime247/mobile-money)
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

```
  📱 MTN MoMo (Cameroon)                           📱 Airtel Money (Kenya)
         │                                                  ▲
         ▼                                                  │
  ┌─────────────────────────────────────────────────────────────────┐
  │                    Mobile Money ↔ Stellar Bridge                │
  │                                                                 │
  │   Deposit (XAF → USDC)  ──►  Stellar Network  ──►  Withdraw    │
  │                              (settles in ~5s)                   │
  └─────────────────────────────────────────────────────────────────┘
```

### Use Cases

- **Remittances** — Send money home across borders at ~1–2% vs 7–10% with traditional services
- **Cross-border B2B payments** — Pay suppliers in other African countries without expensive wire transfers
- **Stable savings** — Convert volatile local currency to USDC via mobile money
- **Merchant payments** — Accept crypto, settle in local mobile money
- **Developer integrations** — Build payment apps on top of our REST + GraphQL APIs

## 🚀 Key Features

### Core Platform
- **Mobile Money Integration** — MTN MoMo, Airtel Money, Orange Money with circuit breaker, failover, and batch payouts
- **Stellar Blockchain** — XLM, USDC, and custom asset support via Stellar SDK + Horizon API
- **Dual API** — REST (40+ endpoints) and GraphQL (queries, mutations, and real-time subscriptions)
- **Real-time Processing** — BullMQ job queues with Redis, admin dashboard at `/admin/queues`
- **WebSocket** — Live transaction updates with JWT auth, per-user rooms, and Redis pub/sub for horizontal scaling
- **Provider Mock Server** — Full mock for MTN + Airtel APIs for local development without real credentials

### Security & Compliance
- **Multi-tier KYC** — Tiered identity verification with document upload (S3) and third-party verification (Entrust)
- **AML Monitoring** — Auto-flagging of suspicious patterns (large transactions, rapid structuring, daily totals)
- **Travel Rule Compliance** — FATF travel rule data collection for qualifying transactions
- **GDPR / Privacy** — Data export, deletion, and consent management endpoints
- **Sanctions Screening** — Automated screening against sanctions lists
- **2FA (TOTP)** — Time-based one-time passwords via Speakeasy, required for withdrawals
- **RBAC** — Role-based access control via Casbin
- **Rate Limiting & Audit Logging** — Multi-layer rate limiting with full audit trail
- **PII Encryption** — AES-256-GCM encryption for sensitive data at rest

### Financial Engine
- **Dynamic Fee Engine** — Configurable fee strategies with VIP tiers (25KB+ fee strategy engine)
- **Transaction Limits** — Provider-specific and KYC-tiered daily limits
- **Vault System** — Secure fund storage with distributed locking
- **Double-Entry Ledger** — Internal accounting system with full transaction journal
- **Dispute Management** — Complete dispute workflow with state machine
- **Monthly Statements** — Automated PDF statement generation
- **Reconciliation** — Provider reconciliation workflows

### Stellar Protocol (SEP) Support
- **SEP-06** — Deposit and Withdrawal API
- **SEP-10** — Web Authentication (challenge-response)
- **SEP-12** — KYC API (customer CRUD with document upload)
- **SEP-24** — Interactive Deposit and Withdrawal (hosted flow)
- **SEP-31** — Cross-Border Payments (send-side anchor)

### Smart Contracts
- **Escrow Contract** — Soroban smart contract for escrowed payments (Rust)
- **HTLC Contract** — Hash Time-Locked Contract for atomic cross-chain swaps (Rust)

### Notifications
- **Email** — SendGrid integration
- **SMS** — Twilio integration
- **Push Notifications** — Firebase Cloud Messaging
- **WhatsApp** — Twilio WhatsApp channel
- **PagerDuty** — Operational alerting

### Developer Tools
- **CLI** (`momo-cli`) — Admin tool for auth, status checks, and transaction retries
- **Kotlin SDK** — Auto-generated from OpenAPI spec
- **Postman Collections** — Pre-built API collections for testing
- **VS Code Extension** — Transaction monitor with live WebSocket logs
- **Swagger UI** — Auto-generated from Zod schemas at `/docs` (dev mode)

## 📋 Prerequisites

- Node.js 20+ (LTS)
- PostgreSQL 16+
- Redis 7+
- Docker (optional, recommended for local dev)

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
- Unit & integration tests across controllers, services, middleware, routes
- Pact consumer-driven contract tests for provider APIs
- Playwright end-to-end tests
- k6 load/stress tests with benchmarking against Go vs Node ingest services
- Stryker mutation testing
- Fuzz testing

> Coverage reports upload to [Codecov](https://codecov.io/gh/sublime247/mobile-money) on every push to main.

## 📚 API Documentation

### Interactive Docs (Development Only)

Start the dev server and visit:
- **Swagger UI**: `http://localhost:3000/docs`
- **OpenAPI JSON**: `http://localhost:3000/docs/openapi.json`

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
  createDeposit(input: {
    amount: "10000"
    phoneNumber: "+237670000000"
    provider: MTN
  }) {
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

| Type | Limit | Purpose |
|------|-------|---------|
| Minimum | 100 XAF | Prevent spam |
| Maximum | 1,000,000 XAF | Fraud prevention |

### KYC-Based Daily Limits

| Level | Daily Limit | Requirements |
|-------|-------------|--------------|
| Unverified | 10,000 XAF | Email only |
| Basic | 100,000 XAF | ID + selfie |
| Full | 1,000,000 XAF | Proof of address + video |

### Provider Limits

| Provider | Min | Max |
|----------|-----|-----|
| MTN | 100 XAF | 500,000 XAF |
| Airtel | 100 XAF | 1,000,000 XAF |
| Orange | 500 XAF | 750,000 XAF |

### AML Monitoring

Auto-flagging of suspicious transactions:
- Single transaction > 1,000,000 XAF
- 24h total > 5,000,000 XAF
- Rapid structuring (3+ mixed in 15 min)
- Sanctions list screening on every transaction

## 🏗️ Architecture

### Tech Stack

| Layer | Technology |
|-------|------------|
| **API Server** | Node.js, TypeScript, Express, Apollo Server (GraphQL) |
| **Database** | PostgreSQL 16 (primary + read replicas), Redis 7 (cache, sessions, pub/sub) |
| **Blockchain** | Stellar SDK, Horizon API, Soroban smart contracts (Rust) |
| **Job Processing** | BullMQ workers, node-cron scheduled jobs |
| **Ingest (High-throughput)** | Go service (fasthttp) + Node.js service (Fastify), Redis Streams, NATS JetStream |
| **Security** | Helmet, bcrypt, JWT, Speakeasy (TOTP), Casbin (RBAC), AES-256-GCM (PII) |
| **Monitoring** | Prometheus, Datadog (dd-trace), Sentry, PagerDuty |
| **Logging** | Structured JSON → Loki/Grafana (primary), ELK stack (secondary) |
| **Edge** | Cloudflare Workers (`.well-known` caching) |
| **Infrastructure** | Docker, Kubernetes (+ Helm, KEDA), Terraform (AWS) |
| **CI/CD** | GitHub Actions (lint, test, build, deploy, rollback) |

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
- Transaction counts by status and provider
- API response times (histograms)
- Queue depths and job latencies
- Error rates by category
- Provider availability and circuit breaker state

### Health Checks

```bash
curl http://localhost:3000/health     # Liveness
curl http://localhost:3000/ready      # Readiness (DB + Redis)
curl http://localhost:3000/health/lb  # Load balancer
```

### Logging

Dual logging stack:
- **Primary**: Structured JSON → Loki → Grafana (included in docker-compose)
- **Secondary**: Filebeat → Logstash → Elasticsearch → Kibana (ELK stack configs in `elk/`)

### Alerting

- **Sentry** — Error tracking and exception monitoring
- **Datadog** — APM tracing (dd-trace)
- **PagerDuty** — Operational alerts (low liquidity, provider outages)

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
- **Deployment** — 3 replicas, rolling updates, startup/liveness/readiness probes, resource limits
- **Worker Deployment** — Separate BullMQ worker pods
- **KEDA Autoscaling** — Scale workers based on queue depth (threshold: 20 jobs, 1–20 replicas)
- **HPA** — CPU-based horizontal pod autoscaling for the API
- **PodDisruptionBudget** — Minimum 2 available pods during disruptions
- **Helm Chart** — Parameterized deployment in `k8s/helm/`

```bash
kubectl apply -f k8s/
```

### Terraform (AWS)

Full AWS infrastructure in `terraform/`:
- VPC with public/private subnets across multiple AZs
- ECS Fargate for containerized deployment
- RDS PostgreSQL with Multi-AZ (production)
- ElastiCache Redis with failover
- Application Load Balancer

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan -var-file=environments/production.tfvars
terraform apply
```

### CI/CD

GitHub Actions pipeline (`.github/workflows/ci.yml`):
1. **Security** — npm audit, Snyk vulnerability scanning
2. **Test** — Lint, Jest (with Postgres + Redis services), Playwright E2E, Codecov upload
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
- **4000-4099**: Validation (HTTP 400)
- **4010-4019**: Authentication (HTTP 401)
- **4030-4039**: Authorization (HTTP 403)
- **4040-4049**: Not Found (HTTP 404)
- **4090-4099**: Conflict (HTTP 409)
- **4290-4299**: Rate Limit (HTTP 429)
- **5000+**: Server Errors (HTTP 500+)

See [src/constants/errorCodes.ts](src/constants/errorCodes.ts) for complete reference.

## 📖 Documentation

Extensive documentation is available in the [`docs/`](docs/) directory (59 documents), covering:

- **Architecture** — System design, Stellar-EVM bridge architecture, ZK balance proofs research
- **Features** — KYC, RBAC, GraphQL, SSO, transaction filtering, monthly statements, vaults
- **Stellar/SEP** — SEP-10/12/31 implementation guides, fee bumping, fee strategy engine
- **Infrastructure** — CI/CD pipeline, Docker dev setup, ELK stack, database backups, distributed locks
- **Integrations** — Bridge provider guides, Orange integration, Zapier/Make.com webhooks
- **Observability** — Metrics, slow query logging, PagerDuty, low liquidity alerts

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

## 🗺️ Roadmap

- [ ] SEP-38 implementation (Quotes and Price Streams)
- [ ] Additional providers (Vodacom, Tigo, M-Pesa)
- [ ] Mobile SDKs (iOS, Android)
- [ ] Merchant dashboard UI
- [ ] Advanced analytics and reporting dashboard
- [ ] Multi-currency settlement support
- [ ] Additional stablecoin support (USDT, EURC)
- [ ] DeFi protocol integrations
- [ ] External accounting integrations (QuickBooks, Xero)

## 📝 License

MIT License — see [LICENSE](LICENSE) file.

## 🙏 Acknowledgments

- [Stellar Development Foundation](https://stellar.org)
- Mobile money providers (MTN, Airtel, Orange)
- Open source community

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/sublime247/mobile-money/issues)
- **Discussions**: [GitHub Discussions](https://github.com/sublime247/mobile-money/discussions)
- **Docs**: [Documentation Portal](docs-portal/)

---

**Built with ❤️ for financial inclusion in Africa**
