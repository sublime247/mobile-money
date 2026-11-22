# CI/CD Pipeline Documentation

## Overview

This document provides comprehensive documentation for the GitHub Actions CI/CD pipeline that automates testing, building, and deployment of the mobile money to Stellar backend service. The pipeline ensures code quality, generates deployable artifacts, and automates staging deployments.

## Pipeline Architecture

The CI/CD system consists of three primary workflows:

1. **CI Workflow** (`.github/workflows/ci.yml`) - Runs on all branches
2. **Dependabot Auto Merge Workflow** (`.github/workflows/dependabot-auto-merge.yml`) - Auto-approves and auto-merges safe dependency remediation PRs after checks pass
3. **CD Workflow** (`.github/workflows/deploy.yml`) - Runs on main branch only after successful CI

### Workflow Execution Flow

```
Code Push → CI Workflow → [Test + Lint + Build + Docker] → CD Workflow → Staging Deployment
```

## CI Workflow Steps

The CI workflow (`.github/workflows/ci.yml`) executes the following jobs:

### 1. Security Job

**Purpose**: Block pull requests and protected branch pushes when high or critical dependency vulnerabilities are detected.

**Steps**:

- Checkout code from repository
- Setup Node.js 20 with npm caching for both lockfiles
- Install the Snyk CLI
- Verify the `SNYK_TOKEN` secret is configured
- Run `npm audit --audit-level=high` and `snyk test --severity-threshold=high` for the repository root package
- Run the same `npm audit` and `snyk test` checks for `bridge-starter-node/`

**Failure Behavior**: Any High or Critical finding fails the workflow and blocks downstream jobs.

### 2. Test Job

**Purpose**: Execute automated tests with coverage reporting

**Steps**:

- Checkout code from repository
- Setup Node.js 20 with npm caching
- Install dependencies using `npm ci`
- Run ESLint for code quality validation
- Execute Jest test suite with coverage

**Services**:

- PostgreSQL 16 (test database on port 5432)
- Redis 7 (test cache on port 6379)

**Environment Variables**:

- `DATABASE_URL`: postgresql://test_user:test_password@localhost:5432/test_db
- `REDIS_URL`: redis://localhost:6379
- `NODE_ENV`: test

**Failure Behavior**: If tests fail, the entire pipeline stops and subsequent jobs are blocked.

### 3. Build Job

**Purpose**: Compile TypeScript code and verify build artifacts

**Steps**:

- Checkout code from repository
- Setup Node.js 20 with npm caching
- Install dependencies using `npm ci`
- Run `npm run build` to compile TypeScript
- Verify build artifacts exist in `dist/` directory

**Dependencies**: Requires successful completion of the test job

**Failure Behavior**: If build fails, Docker image creation is blocked.

### 4. Docker Job

**Purpose**: Build Docker images and push to container registry

**Steps**:

- Checkout code from repository
- Setup Docker Buildx for advanced build features
- Authenticate with container registry
- Build Docker image using `Dockerfile`
- Tag image with multiple tags (commit SHA, branch name, latest)
- Push image to container registry
- Verify image was pushed successfully by pulling it
- Log image location and all assigned tags

**Dependencies**: Requires successful completion of both test and build jobs

**Image Tags**:

- `{repository}:{commit-sha}` - Always applied (e.g., `sublime247/mobile-money:a1b2c3d`)
- `{repository}:{branch-name}` - Always applied (e.g., `sublime247/mobile-money:main`)
- `{repository}:latest` - Only applied on main branch

**Failure Behavior**: If Docker build or push fails, deployment is blocked.

## CD Workflow Steps

The CD workflow (`.github/workflows/deploy.yml`) executes staging deployment:

### 1. Deploy-Staging Job

**Purpose**: Deploy validated Docker images to staging environment

**Trigger Conditions**:

- Only runs when CI workflow completes successfully
- Only runs on main branch
- Triggered automatically via `workflow_run` event

**Steps**:

#### Step 1: Checkout Code

Retrieves repository code for deployment scripts and configuration files.

#### Step 2: Container Registry Authentication

Authenticates with the container registry using credentials stored in GitHub secrets.

#### Step 3: Pull Docker Image

Pulls the Docker image tagged with the commit SHA from the triggering CI workflow.

```bash
docker pull {repository}:{commit-sha}
```

#### Step 4: Validate Environment Variables

Checks that all required environment variables are present before deployment:

- DATABASE_URL
- REDIS_URL
- STELLAR_NETWORK
- STELLAR_HORIZON_URL
- STELLAR_ISSUER_SECRET

If any variables are missing, the deployment fails with a descriptive error message.

#### Step 5: Deploy to Staging

Deploys the application using Docker Compose:

- Stops existing containers if running
- Sets IMAGE_TAG environment variable to commit SHA
- Starts containers using `docker-compose.yml`

#### Step 6: Health Check Verification

Performs health checks to verify successful deployment:

- Polls the staging health endpoint (`/health/lb`)
- Checks every 10 seconds for up to 5 minutes
- Expects HTTP 200 response
- Displays detailed health status on success
- Shows container logs on failure

#### Step 7: Notify Deployment Failure (on failure only)

If deployment fails, collects diagnostic information:

- Displays commit SHA and author
- Shows workflow run URL
- Lists container status
- Displays last 100 lines of container logs

**Failure Behavior**: Deployment failures do not affect the previous working deployment (no automatic rollback needed).

## Container Registry Configuration

### Setting Up Registry Credentials

The pipeline requires authentication with a container registry (Docker Hub, GitHub Container Registry, AWS ECR, etc.).

#### Required GitHub Secrets

Navigate to your repository settings → Secrets and variables → Actions, then add:

1. **REGISTRY_USERNAME**: Your container registry username
   - Docker Hub: Your Docker Hub username
   - GitHub Container Registry: Your GitHub username
   - AWS ECR: AWS access key ID

2. **REGISTRY_PASSWORD**: Your container registry password/token
   - Docker Hub: Docker Hub access token (not your password)
   - GitHub Container Registry: GitHub personal access token with `write:packages` scope
   - AWS ECR: AWS secret access key

#### Docker Hub Example

```bash
# Create Docker Hub access token
1. Log in to Docker Hub
2. Go to Account Settings → Security → New Access Token
3. Create token with Read & Write permissions
4. Copy token and add as REGISTRY_PASSWORD secret
5. Add your Docker Hub username as REGISTRY_USERNAME secret
```

#### GitHub Container Registry Example

```bash
# Create GitHub personal access token
1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate new token (classic)
3. Select scopes: write:packages, read:packages, delete:packages
4. Copy token and add as REGISTRY_PASSWORD secret
5. Add your GitHub username as REGISTRY_USERNAME secret
```

## Required GitHub Secrets

The following secrets must be configured in your repository settings:

### CI Workflow Secrets

| Secret Name         | Description                                 | Example                                |
| ------------------- | ------------------------------------------- | -------------------------------------- |
| `REGISTRY_USERNAME` | Container registry username                 | `myusername`                           |
| `REGISTRY_PASSWORD` | Container registry password/token           | `ghp_abc123...`                        |
| `SNYK_TOKEN`        | Snyk API token for dependency scanning      | `12345678-90ab-cdef-1234-567890abcdef` |

### CD Workflow Secrets

| Secret Name             | Description                              | Example                               |
| ----------------------- | ---------------------------------------- | ------------------------------------- |
| `DATABASE_URL`          | PostgreSQL connection string for staging | `postgresql://user:pass@host:5432/db` |
| `REDIS_URL`             | Redis connection string for staging      | `redis://host:6379`                   |
| `STELLAR_NETWORK`       | Stellar network (TESTNET or PUBLIC)      | `TESTNET`                             |
| `STELLAR_HORIZON_URL`   | Stellar Horizon API endpoint             | `https://horizon-testnet.stellar.org` |
| `STELLAR_ISSUER_SECRET` | Stellar issuer account secret key        | `SXXX...`                             |
| `MTN_API_KEY`           | MTN Mobile Money API key                 | `xxx-xxx-xxx`                         |
| `MTN_API_SECRET`        | MTN Mobile Money API secret              | `xxx`                                 |
| `MTN_SUBSCRIPTION_KEY`  | MTN subscription key                     | `xxx`                                 |
| `AIRTEL_API_KEY`        | Airtel Money API key                     | `xxx`                                 |
| `AIRTEL_API_SECRET`     | Airtel Money API secret                  | `xxx`                                 |
| `ORANGE_API_KEY`        | Orange Money API key                     | `xxx`                                 |
| `ORANGE_API_SECRET`     | Orange Money API secret                  | `xxx`                                 |
| `REQUEST_TIMEOUT_MS`    | Request timeout in milliseconds          | `30000`                               |
| `STAGING_URL`           | Staging environment base URL             | `https://staging.example.com`         |

## Required Environment Variables

### CI Environment (Test Job)

These are configured directly in the workflow file:

```yaml
DATABASE_URL: postgresql://test_user:test_password@localhost:5432/test_db
REDIS_URL: redis://localhost:6379
NODE_ENV: test
```

### Security Environment

- `SNYK_TOKEN` - Required for `snyk test` in CI
- `package-lock.json` - Required in both `/` and `/bridge-starter-node` so `npm audit` and Snyk scan a reproducible dependency graph

## Dependency Security Automation

### Pull Request Security Gate

The CI workflow includes a dedicated `security` job that runs before tests. Add this job as a required branch protection check so High and Critical vulnerability findings block merges to protected branches.

### Dependabot Auto-Patching

The repository uses Dependabot for:

- Daily npm update checks at the repository root
- Daily npm update checks for `bridge-starter-node/`
- Weekly Cargo updates for `contracts/`
- Weekly GitHub Actions updates

Grouped security-update rules are defined in `.github/dependabot.yml`, and `.github/workflows/dependabot-auto-merge.yml` auto-approves and enables automerge for safe patch/minor and grouped security PRs after required checks pass.

### Required Repository Settings

These settings must be enabled in GitHub because they cannot be fully enforced from repository files alone:

1. Enable **Dependabot alerts** and **Dependabot security updates** in repository security settings.
2. Enable **Auto-merge** for pull requests in repository settings.
3. Add the CI `security` job as a **required status check** in the branch protection rule for `main` and any other protected branches.
4. Store the `SNYK_TOKEN` secret under **Settings ƒ+' Secrets and variables ƒ+' Actions**.

### Staging Environment (Deploy Job)

These are loaded from GitHub secrets and passed to the deployment:

- `DATABASE_URL` - PostgreSQL connection for staging database
- `REDIS_URL` - Redis connection for staging cache
- `STELLAR_NETWORK` - Stellar network identifier
- `STELLAR_HORIZON_URL` - Stellar API endpoint
- `STELLAR_ISSUER_SECRET` - Stellar account secret
- Mobile money provider credentials (MTN, Airtel, Orange)
- `REQUEST_TIMEOUT_MS` - API request timeout configuration

## Troubleshooting Guide

### Common Pipeline Failures

#### 1. Test Failures

# Example snippet for your .github/workflows/ci.yml

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        # Add this block to use your authenticated account for service pulls
        credentials:
          username: ${{ secrets.REGISTRY_USERNAME }}
          password: ${{ secrets.REGISTRY_PASSWORD }}
      redis:
        image: redis:7-alpine
        credentials:
          username: ${{ secrets.REGISTRY_USERNAME }}
          password: ${{ secrets.REGISTRY_PASSWORD }}
```

**Symptom**: `Error response from daemon: unauthorized: incorrect username or password` OR `toomanyrequests` during Service Container startup.

**Possible Causes**:

- The `REGISTRY_USERNAME` or `REGISTRY_PASSWORD` secrets are incorrect or expired.
- Docker Hub rate limits reached on GitHub's shared IP.

**Solutions**:

- Update `REGISTRY_PASSWORD` with a fresh **Docker Hub Personal Access Token (PAT)**.
- Ensure `REGISTRY_USERNAME` matches your Docker Hub handle exactly.

**Symptom**: CI workflow fails at "Run tests with coverage" step

**Possible Causes**:

- Code changes broke existing tests
- Database connection issues
- Redis connection issues
- Missing environment variables

**Solutions**:

```bash
# Run tests locally to reproduce
npm run test:coverage

# Check database connection
psql postgresql://test_user:test_password@localhost:5432/test_db

# Check Redis connection
redis-cli -h localhost -p 6379 ping
```

#### 2. Linting Errors

**Symptom**: CI workflow fails at "Run linter" step

**Possible Causes**:

- Code style violations
- ESLint configuration issues

**Solutions**:

```bash
# Run linter locally
npm run lint

# Auto-fix linting issues
npm run lint -- --fix
```

#### 3. Build Failures

**Symptom**: CI workflow fails at "Build" step

**Possible Causes**:

- TypeScript compilation errors
- Missing dependencies
- Type errors

**Solutions**:

```bash
# Run build locally
npm run build

# Check for type errors
npx tsc --noEmit
```

#### 4. Docker Build Failures

**Symptom**: CI workflow fails at "Build and push Docker image" step

**Possible Causes**:

- Invalid Dockerfile syntax
- Missing files referenced in Dockerfile
- Base image not accessible

**Solutions**:

```bash
# Build Docker image locally
docker build -t test-image .

# Check Dockerfile syntax
docker build --no-cache -t test-image .

# Verify base image
docker pull node:20-alpine
```

#### 5. Registry Authentication Failures

**Symptom**: "Log in to Container Registry" step fails

**Possible Causes**:

- Invalid credentials
- Expired access token
- Incorrect secret names

**Solutions**:

1. Verify secrets are set correctly in repository settings
2. Regenerate access token if expired
3. Test credentials locally:

```bash
echo $REGISTRY_PASSWORD | docker login -u $REGISTRY_USERNAME --password-stdin
```

#### 6. Registry Push Failures

**Symptom**: Docker push succeeds but verification fails

**Possible Causes**:

- Network issues
- Registry rate limiting
- Insufficient permissions

**Solutions**:

1. Check registry status page
2. Verify account has push permissions
3. Wait and retry (rate limiting)

#### 7. Deployment Failures

**Symptom**: CD workflow fails at "Deploy to staging" step

**Possible Causes**:

- Missing environment variables
- Docker Compose configuration issues
- Port conflicts
- Insufficient resources

**Solutions**:

```bash
# Check environment variables
echo $DATABASE_URL
echo $REDIS_URL

# Test Docker Compose locally
docker compose -f docker-compose.yml config
docker compose -f docker-compose.yml up

# Check for port conflicts
netstat -tuln | grep 5432
netstat -tuln | grep 6379
```

#### 8. Health Check Failures

**Symptom**: Deployment succeeds but health checks timeout

**Possible Causes**:

- Application startup issues
- Database connection failures
- Missing environment variables
- Application crashes

**Solutions**:

1. Check container logs:

```bash
docker compose -f docker-compose.yml logs
```

2. Verify application is running:

```bash
docker compose -f docker-compose.yml ps
```

3. Test health endpoint manually:

```bash
curl http://localhost:3000/health/lb
```

4. Check database connectivity:

```bash
docker compose exec app node -e "require('./dist/config/database').testConnection()"
```

### Debugging Tips

#### View Workflow Logs

1. Navigate to repository → Actions tab
2. Click on the failed workflow run
3. Click on the failed job
4. Expand the failed step to view detailed logs

#### Re-run Failed Workflows

1. Navigate to the failed workflow run
2. Click "Re-run jobs" → "Re-run failed jobs"
3. Monitor the re-run for success

#### Enable Debug Logging

Add these secrets to enable verbose logging:

- `ACTIONS_STEP_DEBUG`: `true`
- `ACTIONS_RUNNER_DEBUG`: `true`

#### Test Locally

Before pushing, test the pipeline steps locally:

```bash
# Install dependencies
npm ci

# Run linter
npm run lint

# Run tests
npm run test:coverage

# Build application
npm run build

# Build Docker image
docker build -t local-test .

# Run container
docker run -p 3000:3000 local-test
```

## Deployment Process

### Staging Deployment Flow

1. **Developer pushes code to main branch**
   - Code is committed and pushed to GitHub
   - CI workflow is triggered automatically

2. **CI workflow executes**
   - Tests run with PostgreSQL and Redis services
   - Code is linted and type-checked
   - Application is built and compiled
   - Docker image is created and tagged
   - Image is pushed to container registry

3. **CD workflow triggers (on CI success)**
   - Waits for CI workflow to complete successfully
   - Only proceeds if branch is main

4. **Deployment preparation**
   - Authenticates with container registry
   - Pulls Docker image matching commit SHA
   - Validates all required environment variables

5. **Deployment execution**
   - Stops existing staging containers
   - Starts new containers with updated image
   - Waits for containers to initialize

6. **Deployment verification**
   - Polls health endpoint every 10 seconds
   - Waits up to 5 minutes for healthy response
   - Displays health status on success
   - Shows logs and fails on timeout

7. **Post-deployment**
   - On success: Staging environment is updated
   - On failure: Previous deployment remains active, team is notified

### Manual Deployment

To manually trigger a deployment:

1. Navigate to Actions tab
2. Select "CD - Staging Deployment" workflow
3. Click "Run workflow"
4. Select main branch
5. Click "Run workflow" button

### Rollback Procedure

If a deployment causes issues:

1. **Identify last working commit**:

```bash
git log --oneline
```

2. **Revert to previous commit**:

```bash
git revert <bad-commit-sha>
git push origin main
```

3. **Or manually deploy previous image**:

```bash
# Pull previous working image
docker pull {repository}:{previous-commit-sha}

# Tag as current
docker tag {repository}:{previous-commit-sha} {repository}:latest

# Restart containers
docker compose -f docker-compose.yml up -d
```

## Pipeline Status Badges

The README.md displays two status badges:

### CI Status Badge

```markdown
![CI](https://github.com/sublime247/mobile-money/actions/workflows/ci.yml/badge.svg)
```

Shows the current status of the CI workflow:

- Green "passing" - All checks passed
- Red "failing" - One or more checks failed

## Best Practices

### For Developers

1. **Run tests locally before pushing**

   ```bash
   npm run test:coverage
   npm run lint
   ```

2. **Keep commits atomic and focused**
   - One logical change per commit
   - Clear commit messages

3. **Monitor pipeline status**
   - Check Actions tab after pushing
   - Fix failures promptly

4. **Review coverage reports**
   - Maintain or improve coverage
   - Add tests for new features

### For DevOps

1. **Rotate secrets regularly**
   - Update access tokens quarterly
   - Use least-privilege principles

2. **Monitor pipeline performance**
   - Track execution times
   - Optimize slow steps

3. **Keep dependencies updated**
   - Update GitHub Actions versions
   - Update base Docker images

4. **Document changes**
   - Update this document when modifying workflows
   - Communicate changes to team

## Additional Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Docker Documentation](https://docs.docker.com/)
- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [ESLint Documentation](https://eslint.org/docs/latest/)

## Support

For pipeline issues or questions:

1. Check this documentation first
2. Review workflow logs in Actions tab
3. Search existing GitHub issues
4. Create a new issue with detailed information
