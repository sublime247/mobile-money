# Secrets Management Guide

This guide explains how to properly handle secrets, credentials, and sensitive information in the Mobile Money project.

## 🚫 What NOT to Do

**NEVER** commit the following to the repository:
- API keys or tokens
- Database passwords
- SSH keys or private keys
- OAuth secrets or client secrets
- AWS credentials
- Encryption keys
- JWT secrets
- Stellar secret keys
- Webhook URLs with authentication
- Personal access tokens (PATs)
- Any hardcoded credentials

**NEVER**, even in a private commit:
- Hardcode secrets in source files
- Include secrets in `src/` directory
- Add credentials to configuration files that are version-controlled
- Comment out secrets in code (they can be extracted from git history)

## ✅ What TO Do

### 1. Use Environment Variables

**Always use environment variables for sensitive information.**

#### Example - Correct Way:
```typescript
// ❌ WRONG - Hardcoded secret
const dbPassword = "super_secret_password_123";
const db = new Database(dbPassword);

// ✅ RIGHT - Environment variable
const dbPassword = process.env.DATABASE_PASSWORD;
if (!dbPassword) {
  throw new Error("DATABASE_PASSWORD environment variable is required");
}
const db = new Database(dbPassword);
```

### 2. Environment Variable Files

#### Local Development
Create a `.env` file (DO NOT commit this file):
```bash
# .env (local development only - NOT in version control)
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-local-dev-secret-key
STELLAR_ISSUER_SECRET=SBX...
```

#### Staging/Production
Use GitHub Actions Secrets or your deployment platform's secret management:
- Never store in `.env.example` with real values
- Use `.env.example` as a template only

#### .env.example Template:
```bash
# .env.example - Template ONLY, do not store real secrets
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname
REDIS_URL=redis://localhost:6379
JWT_SECRET=replace-with-your-secret
STELLAR_ISSUER_SECRET=replace-with-your-key
```

### 3. Configuration Validation

Validate required secrets on application startup:
```typescript
// src/config.ts
export function validateSecrets(): void {
  const requiredSecrets = [
    'DATABASE_PASSWORD',
    'JWT_SECRET',
    'STELLAR_ISSUER_SECRET',
  ];

  for (const secret of requiredSecrets) {
    if (!process.env[secret]) {
      throw new Error(`Required environment variable not set: ${secret}`);
    }
  }
}
```

### 4. GitHub Actions Secrets

For CI/CD pipelines, use GitHub Actions Secrets:
1. Go to repository Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add secret name and value
4. Reference in workflows: `${{ secrets.SECRET_NAME }}`

Example workflow:
```yaml
env:
  DATABASE_URL: ${{ secrets.DATABASE_URL }}
  JWT_SECRET: ${{ secrets.JWT_SECRET }}
```

## 🛡️ Secret Scanning

This project uses **GitGuardian** via GitHub Actions to automatically scan for accidentally committed secrets.

### Pre-commit Hooks (Local)

Install and run ggshield locally before committing:

#### 1. Install Pre-commit Framework:
```bash
pip install pre-commit
```

#### 2. Install Git Hooks:
```bash
pre-commit install
```

#### 3. Manually Scan:
```bash
# Scan entire repository
ggshield secret scan repo .

# Scan latest commit
ggshield secret scan commit HEAD

# Scan before staging
ggshield secret scan pre-commit
```

### GitHub Actions Scanning

GitGuardian runs automatically on all PRs via `.github/workflows/gitguardian.yml`.

**What to do if a secret is detected:**
1. ❌ **DO NOT** merge the PR
2. 🔑 **Revoke** the compromised secret immediately (reset password, rotate API key, etc.)
3. 🗑️ **Remove** the secret from the PR
4. ✨ **Replace** with environment variable or proper secret management
5. 🔄 **Force-push** to update the branch history
6. ✅ **Re-run** the GitGuardian check

## 🔄 If You Accidentally Commit a Secret

### Option 1: Squash and Force Push (for PRs not yet merged)

```bash
# Amend the commit
git add .
git commit --amend --no-edit

# Force push to your branch
git push --force-with-lease origin feature/your-feature
```

### Option 2: Rewrite Git History (more thorough)

```bash
# Using git-filter-branch (for entire history)
git filter-branch --tree-filter 'sed -i "s/hardcoded_secret/$(process.env.SECRET_VAR)/g" src/file.ts' HEAD

# Then force push
git push --force-with-lease origin feature/your-feature
```

### Option 3: Use BFG Repo-Cleaner (for sensitive data removal)
```bash
# Install: https://rtyley.github.io/bfg-repo-cleaner/
# Remove a string:
bfg --replace-text "secret_value.txt" -- .git/refs

# Push
git push --force-with-lease
```

## 📋 Checklist Before Committing

- [ ] No hardcoded API keys in code
- [ ] No hardcoded passwords in code
- [ ] No hardcoded Stellar secret keys
- [ ] All sensitive values use `process.env.*`
- [ ] `.env` file is in `.gitignore`
- [ ] `.env.example` has placeholders only
- [ ] No secrets in config files
- [ ] No secrets in comments
- [ ] Pre-commit hook ran successfully
- [ ] No warnings from ggshield

## 🔗 Related Documentation

- [GitHub Secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)
- [GitGuardian Documentation](https://docs.gitguardian.com/)
- [12Factor App - Secrets](https://12factor.net/config)
- [OWASP: Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

## 📞 Support

If you accidentally commit a secret:
1. **Immediately** notify the team via private email or Slack
2. **Revoke** the compromised secret in all systems
3. **Report** the incident to the security team
4. **Follow** the remediation steps above

Remember: **It's not a question of IF you'll accidentally commit a secret, but WHEN. Have a plan!**
