# 🚀 Developer Environment Onboarding & Setup Guide

Welcome to the **Mobile Money ↔ Stellar Bridge** developer onboarding documentation. This guide details everything required to configure, launch, test, and contribute to the bridge platform on your local workstation.

---

## 📋 1. System Prerequisites

Before starting, ensure your local system meets the following dependency requirements:

| Component                | Minimum Version | Recommended     | Notes                               |
| ------------------------ | --------------- | --------------- | ----------------------------------- |
| **Node.js**              | `v22.0.0+`      | `v22.14.0`      | JavaScript / TypeScript runtime     |
| **npm**                  | `v10.0.0+`      | `v10.9.0`       | Package manager                     |
| **Docker & Compose**     | `v24.0.0+`      | Latest Desktop  | Containerized Postgres & Redis      |
| **Rust & Cargo**         | `v1.85.0+`      | Latest Stable   | Required for Soroban WASM contracts |
| **wasm32v1-none Target** | N/A             | `wasm32v1-none` | `rustup target add wasm32v1-none`   |
| **Git**                  | `v2.30.0+`      | Latest          | Version control                     |

---

## 🛠️ 2. Repository Setup & Dependencies

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/sublime247/mobile-money.git
   cd mobile-money
   ```

2. **Install Node Dependencies:**

   ```bash
   npm install
   ```

3. **Verify Git Author Identity:**
   ```bash
   git config user.name "AbdulHameedAnofi"
   git config user.email "abdulhameedanofi@gmail.com"
   ```

---

## ⚙️ 3. Environment Configuration

Copy the example environment configuration to `.env`:

```bash
cp .env.example .env
```

Ensure the following key variables are set for local development:

```env
PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://momo_user:momo_password@localhost:5432/momo_bridge?schema=public
REDIS_URL=redis://localhost:6379
JWT_SECRET=super_secret_jwt_development_key_32chars
STELLAR_NETWORK=TESTNET
HORIZON_URL=https://horizon-testnet.stellar.org
```

---

## 🐳 4. Local Infrastructure Stack (Docker)

Spin up PostgreSQL (Port `5432`) and Redis (Port `6379`) using Docker Compose:

```bash
# Start containers in background
npm run docker:dev

# View container logs
docker-compose -f docker-compose.dev.yml logs -f

# Stop containers
npm run docker:dev:down
```

---

## 🗄️ 5. Database Migrations & Data Seeding

Once PostgreSQL is healthy, run database migrations and seed sample development data:

```bash
# Check migration status
npm run migrate:status

# Run all pending SQL migrations
npm run migrate:up

# Seed test users, wallets, and mobile money providers
npm run seed
```

---

## 📱 6. Provider Mock Server & API Development

Launch the Mobile Money Provider Mock Server (simulating MTN, Airtel, and Orange Money callbacks):

```bash
npm run provider-mock:dev
```

In a separate terminal, start the main API server in watcher mode:

```bash
npm run dev
```

API Server: `http://localhost:3000`  
Swagger / OpenAPI Docs: `http://localhost:3000/docs`  
OpenAPI Spec JSON: `http://localhost:3000/openapi.json`

---

## 📜 7. Soroban Smart Contract Development

To compile and verify the Rust Soroban smart contracts (`contracts/`):

```bash
# Add WebAssembly target
rustup target add wasm32v1-none

# Run contract unit tests
npm run contracts:test

# Build release WASM bytecode
npm run contracts:build

# Verify WASM size and compliance
npm run contracts:check
```

---

## 🧪 8. Running Test Suites

Validate codebase health across all test frameworks:

```bash
# Run Jest unit and integration tests
npm test

# Run tests in watch mode
npm run test:watch

# Run TypeScript type checking
npm run type-check

# Run ESLint check
npm run lint

# Run Pact contract tests
npm run test:pact
```

---

## ❓ 9. Troubleshooting & FAQ

### Issue: `sh: jest: command not found`

**Fix:** Run `npm install` at the repository root to ensure all `devDependencies` are installed.

### Issue: `Database connection failed`

**Fix:** Ensure Docker containers are running (`npm run docker:dev`) and Postgres is listening on port `5432`.

### Issue: `Port 3000 in use`

**Fix:** Stop any running instance or override the port: `PORT=3001 npm run dev`.

---

For further details on system architecture and contribution guidelines, see **[ARCHITECTURE.md](ARCHITECTURE.md)** and **[CONTRIBUTING.md](CONTRIBUTING.md)**.
