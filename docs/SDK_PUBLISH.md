# SDK Automated Publish Workflow

This document describes how the automated SDK publish pipeline works and how to configure the required secrets.

## Overview

When a GitHub Release is **published** (not just drafted), the workflow at `.github/workflows/sdk-publish.yml` runs automatically and publishes two SDK packages in parallel:

| SDK | Registry | Package |
|-----|----------|---------|
| Kotlin/JVM | Maven Central (via Sonatype OSSRH) | `com.mobilemoney:mobile-money-sdk` |
| TypeScript | npm registry | `mobile-money-sdk` |

The version is derived directly from the release tag (e.g. `v1.2.3` → `1.2.3`).

## Workflow Trigger

```yaml
on:
  release:
    types: [published]
```

Only the **published** event fires the workflow. Drafting or pre-releasing a release does **not** trigger it. This lets you prepare and review a release before committing to a publish.

## Jobs

```
resolve-version
    ├── publish-kotlin-sdk   (Maven Central)
    └── publish-typescript-sdk  (npm)
            └── publish-summary
```

### `resolve-version`
Strips the leading `v` from the release tag and exposes the clean semver string as a job output used by both publish jobs.

### `publish-kotlin-sdk`
1. Checks out the repo and sets up JDK 17 + Node 20.
2. Starts the API server and generates the Kotlin SDK from the live OpenAPI spec (falls back to `public/openapi.json` if the server is unavailable).
3. Runs `./gradlew test` to verify the generated SDK compiles and passes tests.
4. Publishes to Sonatype OSSRH staging, which automatically promotes to Maven Central.
5. Uploads the built JARs as a workflow artifact (retained 30 days).

### `publish-typescript-sdk`
1. Sets up Node 20 with npm registry auth.
2. Generates the TypeScript SDK from the OpenAPI spec.
3. Runs `npm install && npm run build`.
4. Publishes to npm with `--access public`.
5. Uploads `dist/` as a workflow artifact (retained 30 days).

### `publish-summary`
Writes a Markdown summary table to the GitHub Actions job summary and fails the workflow if either publish job failed.

## Required Secrets

Configure these in **Settings → Secrets and variables → Actions** on the repository.

### Maven Central (Kotlin SDK)

| Secret | Description |
|--------|-------------|
| `SONATYPE_USERNAME` | Sonatype OSSRH username. Use a [user token](https://central.sonatype.org/publish/generate-token/) rather than your account password. |
| `SONATYPE_PASSWORD` | Sonatype OSSRH password / token. |
| `GPG_SIGNING_KEY` | ASCII-armored GPG private key. Export with: `gpg --armor --export-secret-keys <KEY_ID>` |
| `GPG_SIGNING_PASSWORD` | Passphrase for the GPG key. |

#### Generating a GPG key for signing

```bash
# Generate a new key (RSA 4096, no expiry for CI keys)
gpg --full-generate-key

# List keys to find the KEY_ID
gpg --list-secret-keys --keyid-format LONG

# Export the ASCII-armored private key
gpg --armor --export-secret-keys <KEY_ID> | pbcopy   # macOS
gpg --armor --export-secret-keys <KEY_ID> | xclip    # Linux

# Upload the public key to a keyserver (required by Maven Central)
gpg --keyserver keyserver.ubuntu.com --send-keys <KEY_ID>
```

Paste the output of `--export-secret-keys` as the value of `GPG_SIGNING_KEY`.

#### Sonatype OSSRH setup

1. Create an account at [https://issues.sonatype.org](https://issues.sonatype.org).
2. Open a ticket to claim the `com.mobilemoney` namespace.
3. Once approved, generate a **user token** at [https://s01.oss.sonatype.org](https://s01.oss.sonatype.org) → Profile → User Token.
4. Use the token username/password as `SONATYPE_USERNAME` / `SONATYPE_PASSWORD`.

### npm (TypeScript SDK)

| Secret | Description |
|--------|-------------|
| `NPM_TOKEN` | npm automation token. Generate at [https://www.npmjs.com/settings/\<username\>/tokens](https://www.npmjs.com/settings). Choose **Automation** type. |

## Optional: `sdk-publish` Environment

The workflow references an optional GitHub Environment named `sdk-publish`. If you create this environment in **Settings → Environments**, you can:

- Require manual approval before publishing.
- Restrict which branches/tags can trigger the publish.
- Add environment-specific secrets.

If the environment does not exist, the jobs run without approval gates.

## Graceful degradation

If any required secret is missing, the corresponding publish step is **skipped** (not failed) and a warning is printed to the job log. The workflow still succeeds so that the release is not blocked. This allows the workflow to be merged before all secrets are configured.

## Local testing

To test SDK generation locally without publishing:

```bash
# Start the dev server
npm run dev

# Generate Kotlin SDK
openapi-generator-cli generate \
  -i http://localhost:3000/docs/openapi.json \
  -c sdk-config.yaml \
  -o sdk \
  --additional-properties=artifactVersion=1.0.0-local

# Build and test
cd sdk && ./gradlew build

# Generate TypeScript SDK
openapi-generator-cli generate \
  -i http://localhost:3000/docs/openapi.json \
  -c sdk-config-ts.yaml \
  -o sdk-ts \
  --additional-properties=npmVersion=1.0.0-local

# Build
cd sdk-ts && npm install && npm run build
```

## Version strategy

The SDK version is always derived from the GitHub release tag:

| Release tag | Published version |
|-------------|-------------------|
| `v1.2.3`    | `1.2.3`           |
| `v2.0.0`    | `2.0.0`           |
| `v1.3.0-rc.1` | `1.3.0-rc.1`   |

Snapshot versions (ending in `-SNAPSHOT`) are published to the Sonatype snapshots repository instead of staging.

## Troubleshooting

**Kotlin publish fails with "401 Unauthorized"**
- Verify `SONATYPE_USERNAME` and `SONATYPE_PASSWORD` are set and use a user token (not account credentials).

**Kotlin publish fails with "Signature invalid"**
- Ensure `GPG_SIGNING_KEY` contains the full ASCII-armored key including the `-----BEGIN PGP PRIVATE KEY BLOCK-----` header/footer.
- Verify the public key has been uploaded to a keyserver.

**npm publish fails with "403 Forbidden"**
- Ensure `NPM_TOKEN` is an **Automation** token, not a read-only token.
- Verify the package name `mobile-money-sdk` is not already claimed by another user/org on npm.

**OpenAPI spec generation fails**
- The workflow falls back to `public/openapi.json`. Ensure this file is kept up to date by running `npm run generate:openapi` before tagging a release.
