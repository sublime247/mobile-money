# Docker Compose — Local Development

This guide covers running the full mobile-money stack locally with a single command.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Compose v2)
- A copy of `.env` in the project root (see below)

## First-time setup

```bash
# 1. Copy the example env file
cp .env.example .env

# 2. Fill in your Stellar and mobile-money provider credentials
#    DATABASE_URL and REDIS_URL are overridden automatically by Compose
#    and do not need to be changed for local development.
```

## Start the stack

```bash
docker compose up
```

This starts three containers:

| Container | Service | Port |
|-----------|---------|------|
| `mobilemoney_postgres` | PostgreSQL 16 | `5432` |
| `mobilemoney_redis` | Redis 7 | `6379` |
| `mobilemoney_app` | Node/Express (live reload) | `3000` |

The app waits for Postgres and Redis to pass their healthchecks before starting, so there are no race-condition connection errors on a cold boot.

The schema at `database/schema.sql` and any migrations under `database/migrations/` are applied automatically the first time the Postgres volume is created.

## Live reload

Source files are bind-mounted into the container. Any edit to a file under `src/` triggers an automatic restart via `ts-node-dev` — no rebuild required.

## Verify the stack is healthy

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"..."}
```

## Useful commands

```bash
# View logs for all services
docker compose logs -f

# View logs for one service
docker compose logs -f app

# Open a psql shell
docker compose exec postgres psql -U user -d mobilemoney_stellar

# Open a Redis CLI
docker compose exec redis redis-cli

# Restart just the app (e.g. after changing .env)
docker compose restart app

# Stop everything and keep volumes (data persists)
docker compose down

# Stop everything and wipe all data (fresh start)
docker compose down -v
```

## Running tests against the stack

```bash
# With the stack running, execute tests on the host
npm test

# Or run tests inside the app container
docker compose exec app npm test
```

## Stopping

```bash
docker compose down
```