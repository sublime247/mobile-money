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

### Coverage Requirements

- Minimum coverage: 70% (branches, functions, lines, statements)
- Coverage reports uploaded to Codecov automatically
- View detailed reports: https://codecov.io/gh/sublime247/mobile-money

## KYC Transaction Limits

The system enforces daily transaction limits based on user KYC (Know Your Customer) verification levels to prevent fraud while encouraging users to complete higher levels of verification.

### Per-Transaction Amount Limits

Before checking daily KYC limits, the system validates that each individual transaction falls within acceptable ranges:

| Limit Type | Amount  | Purpose                                      |
| ---------- | ------- | -------------------------------------------- |
| Minimum    | 100 XAF | Prevents micro-transactions and spam         |
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

### Health Checks

- `GET /health` - Service health status (liveness)
- `GET /ready` - Readiness probe for Kubernetes (checks database and redis)

### Transactions

- `POST /api/transactions/deposit` - Deposit from mobile money to Stellar
- `POST /api/transactions/withdraw` - Withdraw from Stellar to mobile money
- `GET /api/transactions/:id` - Get transaction status

### Statistics & Metrics

- `GET /api/stats` - Get system-wide statistics (Total transactions, success rate, total volume, active users, and volume by provider).
- **Authentication**: Requires a valid administrative API key in the `X-API-Key` header.
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
| Parameter   | Type   | Description |
| :---------- | :----- | :---------- |
| `startDate` | string | ISO 8601 format (e.g., 2026-03-01). |
| `endDate`   | string | ISO 8601 format (e.g., 2026-03-31). |
| `page`      | number | The page number to retrieve (Default: 1). |
| `limit`     | number | Number of transactions per page (Default: 10). |

**Example Request:**
`GET /api/transactions?startDate=2026-03-01&endDate=2026-03-31&page=1&limit=5`

**Validation Rules:**
- Returns `400 Bad Request` if the date format is not ISO 8601.
- Returns `400 Bad Request` if `startDate` is a later date than `endDate`.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT
