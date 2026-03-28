# Mobile Money to Stellar Backend

[![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](https://github.com/sublime247/mobile-money/issues)
![CI](https://github.com/sublime247/mobile-money/actions/workflows/ci.yml/badge.svg)
![Coverage](https://codecov.io/gh/sublime247/mobile-money/branch/main/graph/badge.svg)

A backend service that bridges mobile money providers (MTN, Airtel, Orange) with the Stellar blockchain network.

## Features

- Mobile money integrations (MTN, Airtel, Orange)
- Stellar blockchain integration
- RESTful API and GraphQL (`/graphql`)
- PostgreSQL database
- Redis (for queues and locking)
- Background processing (BullMQ)
- Email notifications (Nodemailer)
- **No-code webhook integration (Zapier/Make.com)**
- Email notifications (SendGrid)
- Docker support
- TypeScript

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Docker (optional)

### Installation

1. Clone the repository
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy environment variables:

   ```bash
   cp .env.example .env
   ```

4. Update `.env` with your credentials

### Development

```bash
npm run dev
```

Add `CORS_MAX_AGE` to your local `.env` to control how long browsers cache CORS
preflight responses:

```bash
CORS_MAX_AGE=86400
```

For OAuth2-enabled API access, also configure a client, redirect URI, and JWT
signing secret in your local `.env`:

```bash
ADMIN_API_KEY=dev-admin-key
OAUTH_CLIENT_ID=mobile-money-client
OAUTH_CLIENT_SECRET=replace-with-a-secure-client-secret
OAUTH_REDIRECT_URI=http://localhost:3000/oauth/callback
OAUTH_JWT_SECRET=replace-with-a-dedicated-oauth-jwt-secret
```

### Production

```bash
npm run build
npm start
```

### Docker

```bash
docker-compose up
```

### Docker (Development)

Starts the app with hot reload, a debugger on port `9229`, PostgreSQL, and Redis.

```bash
# Start
npm run docker:dev

# Stop
npm run docker:dev:down
```

Attach a debugger (e.g. VS Code) to `localhost:9229`.

## Testing

### Run Tests

```bash
npm test
```

### Run Tests with Coverage

```bash
npm run test:coverage
```

### Watch Mode

```bash
npm run test:watch
```

### Verify CORS Preflight Caching

The API sends `Access-Control-Max-Age` on successful preflight responses so
browsers can cache them and reduce repeated `OPTIONS` requests. Configure the
cache duration with:

```bash
CORS_MAX_AGE=86400
```

To validate locally, send a preflight request and confirm the response header:

```bash
curl -i -X OPTIONS http://localhost:3000/health \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: GET"
```

The response should include:

```text
Access-Control-Max-Age: 86400
```

In a browser, the Network tab should show fewer repeated `OPTIONS` requests for
the same origin, method, and headers until the cache expires.

### Verify OAuth2 Authentication

The API exposes an OAuth2 authorization-code flow with JWT access tokens and
rotating refresh tokens:

- `GET /oauth/authorize`
- `POST /oauth/token`

This implementation uses the existing administrative API key to authorize the
resource owner step until a dedicated end-user login screen exists. The
authorization endpoint requires:

- `X-API-Key: <ADMIN_API_KEY>`
- `response_type=code`
- `client_id`
- `redirect_uri`
- `subject`

Example authorization request:

```bash
curl -i "http://localhost:3000/oauth/authorize?response_type=code&client_id=mobile-money-client&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Foauth%2Fcallback&subject=user-123&scope=reports%3Aread&state=abc123" \
  -H "X-API-Key: dev-admin-key"
```

The response redirects to the configured callback with `code` and `state`.

Exchange that code for tokens:

```bash
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "client_id=mobile-money-client" \
  -d "client_secret=replace-with-a-secure-client-secret" \
  -d "redirect_uri=http://localhost:3000/oauth/callback" \
  -d "code=<authorization-code>"
```

Refresh an access token:

```bash
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "client_id=mobile-money-client" \
  -d "client_secret=replace-with-a-secure-client-secret" \
  -d "refresh_token=<refresh-token>"
```

Access tokens expire after 1 hour by default. Refresh tokens expire after 30
days by default and are rotated on every refresh. Authorization codes expire
after 5 minutes. Access protected endpoints by sending:

```bash
Authorization: Bearer <access-token>
```

### Coverage Requirements

- Minimum coverage: 70% (branches, functions, lines, statements)
- Coverage reports uploaded to Codecov automatically
- View detailed reports: https://codecov.io/gh/sublime247/mobile-money

## KYC Transaction Limits

The system enforces daily transaction limits based on user KYC (Know Your Customer) verification levels to prevent fraud while encouraging users to complete higher levels of verification.

### Per-Transaction Amount Limits

Before checking daily KYC limits, the system validates that each individual transaction falls within acceptable ranges:

| Limit Type | Amount        | Purpose                                        |
| ---------- | ------------- | ---------------------------------------------- |
| Minimum    | 100 XAF       | Prevents micro-transactions and spam           |
| Maximum    | 1,000,000 XAF | Fraud prevention for single large transactions |

These limits can be configured via environment variables:

```bash
MIN_TRANSACTION_AMOUNT=100        # Minimum per-transaction amount (XAF)
MAX_TRANSACTION_AMOUNT=1000000    # Maximum per-transaction amount (XAF)
```

### KYC Levels and Daily Limits

| KYC Level  | Daily Limit   | Description                             |
| ---------- | ------------- | --------------------------------------- |
| Unverified | 10,000 XAF    | Default level for new users             |
| Basic      | 100,000 XAF   | Requires basic identity verification    |
| Full       | 1,000,000 XAF | Requires complete identity verification |

### How Limits Are Enforced

1. **Per-Transaction Validation**: Each transaction is first checked against MIN and MAX amount limits
2. **Daily Limit Calculation**: Limits are calculated using a **rolling 24-hour window** from the current time
3. **Transaction Aggregation**: Both deposit and withdrawal transactions count toward the daily total
4. **Status Filtering**: Only completed transactions are included in the calculation
5. **Pre-Processing Check**: Limits are checked before each transaction is processed
6. **Clear Error Messages**: If a transaction is rejected, a detailed error message explains why

### Configuration

Transaction limits can be configured via environment variables:

```bash
# Per-transaction limits
MIN_TRANSACTION_AMOUNT=100        # Minimum per-transaction amount (XAF)
MAX_TRANSACTION_AMOUNT=1000000    # Maximum per-transaction amount (XAF)

# Daily KYC limits
LIMIT_UNVERIFIED=10000    # Daily limit for unverified users (XAF)
LIMIT_BASIC=100000        # Daily limit for basic KYC users (XAF)
LIMIT_FULL=1000000        # Daily limit for full KYC users (XAF)
```

If not specified, the system uses the default values shown above.

### Benefits of Upgrading KYC Levels

- **Unverified → Basic**: Increase your daily limit from 10,000 XAF to 100,000 XAF (10x increase)
- **Basic → Full**: Increase your daily limit from 100,000 XAF to 1,000,000 XAF (10x increase)
- Higher limits enable larger transactions and better support for business use cases

When a transaction is rejected due to limit exceeded, the error response includes your current KYC level, remaining limit, and upgrade suggestions.

## Provider-Specific Transaction Limits

Different mobile money providers have different capabilities and risk profiles. The system enforces provider-specific transaction limits before checking KYC limits.

### Default Limits

| Provider | Minimum | Maximum       | Description                                     |
| -------- | ------- | ------------- | ----------------------------------------------- |
| MTN      | 100 XAF | 500,000 XAF   | Most common mobile money provider               |
| Airtel   | 100 XAF | 1,000,000 XAF | Higher maximum for larger transactions          |
| Orange   | 500 XAF | 750,000 XAF   | Slightly higher minimum due to network policies |

### How Provider Limits Work

1. **First Validation**: Each transaction is first checked against provider-specific min/max limits
2. **Provider Detection**: The provider is determined from the transaction request (mtn, airtel, orange)
3. **Clear Error Messages**: If rejected, the error includes the allowed range for that provider

Example error message:

```
Amount 600 XAF is below the minimum of 500 XAF for ORANGE. Allowed range: 500 - 750000 XAF
```

### Configuration

Provider limits can be customized via environment variables:

```bash
# MTN limits
MTN_MIN_AMOUNT=100
MTN_MAX_AMOUNT=500000

# Airtel limits
AIRTEL_MIN_AMOUNT=100
AIRTEL_MAX_AMOUNT=1000000

# Orange limits
ORANGE_MIN_AMOUNT=500
ORANGE_MAX_AMOUNT=750000
```

If not specified, the system uses the default values shown above.

## AML Monitoring and Review

The API now includes built-in Anti-Money Laundering (AML) monitoring for every
new deposit and withdrawal request. Each new transaction is evaluated against
configurable AML rules, and suspicious activity is flagged for compliance
review.

### Default AML Rules

- Single transaction amount > `1,000,000 XAF`
- Rolling 24-hour transaction total > `5,000,000 XAF`
- Rapid deposit/withdraw structuring pattern (default: 3+ mixed in/out transactions within 15 minutes)

### AML Configuration

```bash
AML_SINGLE_TRANSACTION_THRESHOLD_XAF=1000000
AML_DAILY_TOTAL_THRESHOLD_XAF=5000000
AML_ROLLING_WINDOW_HOURS=24
AML_RAPID_WINDOW_MINUTES=15
AML_RAPID_TRANSACTION_COUNT=3
AML_STRUCTURING_FLOOR_XAF=100000
```

### Manual Review Workflow

Flagged transactions are automatically tagged for review (`aml-flagged`,
`aml-review`) and AML alert metadata is attached to the transaction.

Compliance endpoints:

- `GET /api/transactions/aml/alerts` - list AML alerts (filter by `status`, `userId`, `startDate`, `endDate`)
- `PATCH /api/transactions/aml/alerts/:alertId/review` - mark alert as `reviewed` or `dismissed`
- `GET /api/reports/aml` - AML summary report with status/rule breakdown

All AML alerts are logged for audit visibility.

## Git Hooks

This project uses [Husky](https://typicode.github.io/husky/) to enforce code quality via Git hooks.

### Pre-commit

A pre-commit hook is configured to run before every commit. It executes:

- `npm run lint`: Checks for linting errors.
- `npm run type-check`: Verifies TypeScript types.
- `npm test`: Runs the test suite.
- `npx lint-staged`: Automatically formats staged files.

If any of these checks fail, the commit will be rejected.

### Bypassing Hooks

If you need to bypass the pre-commit hooks (e.g., for a WIP commit), you can use the `--no-verify` flag:

```bash
git commit -m "Your message" --no-verify
```

## API Endpoints

## System Architecture
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

### Health Checks

- `GET /health` - Service health status (liveness)
- `GET /ready` - Readiness probe for Kubernetes (checks database and redis)

### Transactions

- `GET /api/transactions` - Transaction history (date range, pagination)
- `GET /api/transactions/search` - Search (see handler; may return 501 if not implemented)
- `POST /api/transactions/deposit` - Deposit from mobile money to Stellar
- `POST /api/transactions/withdraw` - Withdraw from Stellar to mobile money
- `GET /api/transactions/:id` - Get transaction status
- `POST /api/transactions/:id/cancel` - Cancel a pending transaction
- Disputes: `POST /api/transactions/:id/dispute` and `/api/disputes/*` (status workflow, notes, report)

#### Transaction Idempotency

Send an `Idempotency-Key` header on `POST /api/transactions/deposit` and
`POST /api/transactions/withdraw` when the client may retry the same request.

- duplicate requests with the same active key return the existing transaction
  with HTTP `200`
- keys remain active for `24` hours by default
- expired keys are cleared during cleanup so they can be reused safely later
- race conditions are still protected by the database unique index on
  `transactions.idempotency_key`

### Statistics & Metrics

- `GET /api/stats` - Get system-wide statistics (Total transactions, success rate, total volume, active users, and volume by provider).
- **Authentication**: Requires a valid administrative API key in the `X-API-Key` header or a valid OAuth bearer token in the `Authorization` header.
- **Cache**: Results are cached for 15 minutes.
- **Filters**: Supports `startDate` and `endDate` query parameters (ISO format).

### GraphQL

- `POST /graphql` (and Playground at `GET /graphql` in development)
- See [docs/GRAPHQL.md](docs/GRAPHQL.md) for authentication, schema notes, and examples

## Project Structure

```
src/
├── config/          # Configuration files
├── services/        # Business logic
│   ├── stellar/     # Stellar integration
│   └── mobilemoney/ # Mobile money providers
├── routes/          # API routes
├── graphql/         # GraphQL schema, resolvers, Apollo server setup
├── models/          # Database models
├── middleware/      # Express middleware
└── index.ts         # Entry point
```

## API Documentation Updates

### Transaction History

**Endpoint:** `GET /api/transactions`

Allows users to view their transaction history with built-in pagination and date-range filtering.

**Query Parameters:**
| Parameter | Type | Description |
| :---------- | :----- | :---------- |
| `startDate` | string | ISO 8601 format (e.g., 2026-03-01). |
| `endDate` | string | ISO 8601 format (e.g., 2026-03-31). |
| `page` | number | The page number to retrieve (Default: 1). |
| `limit` | number | Number of transactions per page (Default: 10). |

**Example Request:**
`GET /api/transactions?startDate=2026-03-01&endDate=2026-03-31&offset=0&limit=5`

**Validation Rules:**

- Returns `400 Bad Request` if the date format is not ISO 8601.
- Returns `400 Bad Request` if `startDate` is a later date than `endDate`.

## SMS notifications (Twilio)

The queue worker can text users on **transaction completed** and **transaction failed**. Set `SMS_PROVIDER=twilio` and provide `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER`. **No SMS is sent** when `NODE_ENV=test` or `SMS_PROVIDER=none`. Per-destination rate limiting uses `SMS_MAX_PER_PHONE_PER_HOUR` and `SMS_RATE_LIMIT_WINDOW_MS`. Numbers are normalized to E.164; use `SMS_DEFAULT_REGION` (ISO country code, default `CM`) when the stored number has no `+` prefix.

## Transaction retries

Transient failures (timeouts, connection issues, throttling / 5xx-style errors) are retried inside the worker with exponential backoff: wait `RETRY_DELAY_MS * 2^(attempt-1)` between attempts. Configure `MAX_RETRY_ATTEMPTS` (default `3`) and `RETRY_DELAY_MS` (default `1000`). The `transactions.retry_count` column is incremented before each retry; run `npm run migrate:up` to apply migration `003_add_retry_count`.

## Stellar custom assets

Leave `STELLAR_ASSET_CODE` empty for native XLM. To pay a custom or anchored asset (for example USDC), set `STELLAR_ASSET_CODE` and `STELLAR_ASSET_ISSUER`. The destination account must already hold a trustline for that asset, or the payment fails with an explicit error. Balance checks use the same configured asset. See `src/services/stellar/assetService.ts`.

## Disputes

Disputes are limited to transactions in **completed** or **failed** status. Workflow, notes, assignment, and reporting are exposed via the dispute routes in `src/routes/disputes.ts` and GraphQL where applicable.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Development seeds

There is a small seed script to populate sample users and transactions for local development.

Run (development only):

```bash
# Ensure you have a .env with DATABASE_URL and set NODE_ENV=development
npm run seed
```

Notes:

- Idempotent: repeated runs won't duplicate records (uses UPSERT / ON CONFLICT DO NOTHING).
- Creates a few sample users and a mix of transactions (completed, pending, failed) across providers.
- Intended for local/dev environments only; the script will exit if NODE_ENV !== development.
