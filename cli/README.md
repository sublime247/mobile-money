# momo-cli

Admin maintenance CLI for the mobile-money service with beautiful console dashboard and system monitoring.

## Setup

```bash
cd cli && npm install
```

Run the interactive setup wizard to create `cli/.momorc`:

```bash
npm run dev -- setup
```

If you prefer to create it manually, use:

```
MOMO_API_URL=https://your-production-url
MOMO_API_KEY=your-admin-api-key
```

## Commands

### Dashboard & Monitoring

```bash
npm run dev -- dashboard                                          # show system dashboard
npm run dev -- dashboard --watch                                  # auto-refresh dashboard (5s default)
npm run dev -- dashboard --watch --interval 3000                  # refresh every 3 seconds
npm run dev -- dashboard:live                                     # compact live status monitor
npm run dev -- dashboard:export                                   # export metrics as JSON
```

See [DASHBOARD.md](./DASHBOARD.md) for detailed dashboard documentation.

### Transaction Management

```bash
npm run dev -- auth check                                         # verify API key
npm run dev -- status <transactionId>                             # get transaction details
npm run dev -- retry <transactionId>                              # force-retry a failed transaction
```

### Profile Management

```bash
npm run dev -- profile save <name> --url <url> --key <key>       # save a profile
npm run dev -- profile use <name>                                 # switch to a profile
npm run dev -- profile list                                       # list all profiles
npm run dev -- profile delete <name>                              # delete a profile
```

## Configuration Profiles

The CLI supports multiple configuration profiles for Dev/Staging/Production environments. Profiles are stored in `cli/.momo-profiles.json`.

### Save a Profile

```bash
npm run dev -- profile save dev --url http://localhost:3000 --key your-dev-api-key
npm run dev -- profile save staging --url https://staging.example.com --key your-staging-api-key
npm run dev -- profile save production --url https://api.production.com --key your-prod-api-key
```

### Switch to a Profile

```bash
npm run dev -- profile use production
```

### List All Profiles

```bash
npm run dev -- profile list
```

The currently active profile is marked with `← active`.

### Delete a Profile

```bash
npm run dev -- profile delete staging
```

### Configuration Priority

The CLI uses credentials in the following order of priority:

1. Active profile (set via `profile use`)
2. Environment variables (`MOMO_API_KEY`, `MOMO_API_URL`)
3. `.momorc` file
