# Sentry Release Synchronization & Deployment Tracking Tools

This directory contains tools for registering version releases and recording deployments in Sentry.

## Tools Included

### 1. Bash Script (`sentry-release-sync.sh`)

A standard shell script to run within Unix-like CI/CD pipelines (e.g., GitHub Actions, GitLab CI/CD, CircleCI).
It automatically detects and downloads the `sentry-cli` if not found in the environment, and performs release registration.

### 2. TypeScript Script (`sentry-release-sync.ts`)

A script that fits natively into the project's TypeScript execution context.
It can be executed via `tsx` or compile-time execution scripts.

## Environment Variables Required

The following environment variables must be configured in your environment or defined in a `.env` file at the root of the project:

- `SENTRY_AUTH_TOKEN`: Your Sentry API authorization token.
- `SENTRY_ORG` (or `SENTRY_ORGANIZATION`): The slug of your Sentry Organization.
- `SENTRY_PROJECT` (or `SENTRY_PROJECT_NAME`): The slug of your Sentry Project.
- `SENTRY_RELEASE` (optional): The release version string. If omitted, the tool resolves it using `git rev-parse HEAD`.
- `ENVIRONMENT` (optional): The environment slug (e.g. `production`, `staging`, `development`). Defaults to `production`.

## How to Run

### Run Bash Script:

```bash
chmod +x logging/sentry-release-sync.sh
./logging/sentry-release-sync.sh
```

### Run TypeScript Script:

```bash
npx tsx logging/sentry-release-sync.ts
```
