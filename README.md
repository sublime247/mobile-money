# Mobile Money to Stellar Backend

[![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](https://github.com/sublime247/mobile-money/issues)
[![codecov](https://codecov.io/gh/sublime247/mobile-money/branch/main/graph/badge.svg)](https://codecov.io/gh/sublime247/mobile-money)
[![CI](https://github.com/sublime247/mobile-money/workflows/CI/badge.svg)](https://github.com/sublime247/mobile-money/actions)

A backend service that bridges mobile money providers (MTN, Airtel, Orange) with the Stellar blockchain network.

## Features

- Mobile money integrations (MTN, Airtel, Orange)
- Stellar blockchain integration
- RESTful API
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

## API Endpoints

### Health Checks
- `GET /health` - Service health status (liveness)
- `GET /ready` - Readiness probe for Kubernetes (checks database and redis)

### Transactions
- `POST /api/transactions/deposit` - Deposit from mobile money to Stellar
- `POST /api/transactions/withdraw` - Withdraw from Stellar to mobile money
- `GET /api/transactions/:id` - Get transaction status

## Project Structure

```
src/
├── config/          # Configuration files
├── services/        # Business logic
│   ├── stellar/     # Stellar integration
│   └── mobilemoney/ # Mobile money providers
├── routes/          # API routes
├── models/          # Database models
├── middleware/      # Express middleware
└── index.ts         # Entry point
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT
