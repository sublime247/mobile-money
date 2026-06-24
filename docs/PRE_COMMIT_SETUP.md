# Pre-commit Hooks Setup Guide

This guide helps you set up local secret scanning and code quality checks to prevent accidental commits of secrets and other issues.

## 🚀 Quick Start

### 1. Install Pre-commit Framework

**macOS/Linux:**
```bash
brew install pre-commit
# or
pip install pre-commit
```

**Windows (PowerShell):**
```powershell
pip install pre-commit
```

### 2. Install Git Hooks

From the project root:
```bash
pre-commit install
```

This installs git hooks that automatically run before each commit.

### 3. Run Manually (Optional)

```bash
# Scan all files
pre-commit run --all-files

# Scan specific file types
pre-commit run ggshield --all-files

# Run just before committing
pre-commit run
```

## 🛡️ What Gets Checked

The pre-commit hooks check for:

### Secret Scanning
- **ggshield** - Detects secrets using GitGuardian rules
- **detect-private-key** - Detects SSH keys, PGP keys, etc.
- **detect-aws-credentials** - Detects AWS access keys

### Code Quality
- **Trailing whitespace** - Removes extra spaces
- **End-of-file-fixer** - Ensures files end with newline
- **YAML validator** - Checks YAML syntax
- **JSON validator** - Checks JSON syntax
- **Large files** - Prevents commits of files > 1MB

### Linting
- **ESLint** - TypeScript/JavaScript linting

## ⚙️ Configuration

Pre-commit configuration is in `.pre-commit-config.yaml`.

### Update Hooks

Keep hooks up to date:
```bash
# Show outdated hooks
pre-commit autoupdate

# Then commit the updated `.pre-commit-config.yaml`
```

## 🆘 Troubleshooting

### Hook Running Slowly

The first run may take time downloading dependencies. Subsequent runs are faster.

```bash
# Speed up by pre-caching
pre-commit install-hooks
```

### Bypass Hooks (Not Recommended)

Only in emergencies:
```bash
git commit --no-verify
```

⚠️ **Warning**: Bypassing hooks means secrets could slip through!

### Clear Cache

```bash
pre-commit clean
```

### Specific Hook Issues

**ggshield Issues:**
```bash
# Install ggshield
pip install ggshield

# Verify it works
ggshield secret scan repo .

# Check API key
ggshield auth status
```

**ESLint Issues:**
```bash
# Reinstall dependencies
rm -rf node_modules
pnpm install
```

## 📋 Common Commands

```bash
# Run all pre-commit hooks
pre-commit run --all-files

# Run specific hook
pre-commit run ggshield --all-files

# Uninstall hooks
pre-commit uninstall

# Reinstall hooks
pre-commit install

# Get hook info
pre-commit info-hooks

# Show hook stages
pre-commit config

# Skip hooks for this commit only
SKIP=ggshield git commit -m "message"
```

## 🔑 Setting Up ggshield API Key

ggshield needs access to GitGuardian's API for advanced scanning:

### 1. Get Your API Key

- Go to [GitGuardian Dashboard](https://dashboard.gitguardian.com/)
- Settings → API keys
- Create a new personal API key (copy it)

### 2. Configure ggshield

**Option A: Environment Variable**
```bash
export GITGUARDIAN_API_KEY="your-api-key-here"
```

**Option B: Config File**
```bash
# macOS/Linux
mkdir -p ~/.config/ggshield
cat > ~/.config/ggshield/config.yaml << EOF
gitguardian:
  api_key: "your-api-key-here"
EOF

# Windows
mkdir %USERPROFILE%\.ggshield
# Create config.yaml with your API key
```

**Option C: Prompt on First Use**
```bash
ggshield auth configure
```

### 3. Verify Setup

```bash
ggshield auth status
ggshield secret scan repo .
```

## 🚀 For Development Team

### After Cloning the Repository

```bash
# Clone
git clone https://github.com/sublime247/mobile-money.git
cd mobile-money

# Install pre-commit
pre-commit install

# Install project dependencies
pnpm install

# Now commits are protected!
```

### Setting Up CI/CD Secrets

In GitHub:
1. Settings → Secrets and variables → Actions
2. Add `GITGUARDIAN_API_KEY` secret

This enables GitGuardian scanning in CI/CD pipelines.

## 📚 Resources

- [GitGuardian ggshield Docs](https://docs.gitguardian.com/ggshield-docs)
- [pre-commit Framework Docs](https://pre-commit.com/)
- [Secrets Management Guide](./SECRETS_MANAGEMENT.md)
- [12Factor App - Config](https://12factor.net/config)

## ✅ Verification

After setup, verify everything works:

```bash
# 1. Verify git hooks installed
ls -la .git/hooks/ | grep pre-commit

# 2. Test by trying to commit a fake secret
echo "password123abc = 'super_secret_key'" > test_secret.ts
git add test_secret.ts
git commit -m "Test" # This should fail

# 3. Remove test file
rm test_secret.ts
git reset --hard
```

## 💡 Tips

1. **First run takes time** - Downloading tools and dependencies for the first time
2. **Keep API key safe** - Treat like password, never commit it
3. **Update regularly** - Run `pre-commit autoupdate` monthly
4. **Check logs** - If hook fails, read the output carefully
5. **Ask questions** - If setup issues, ask the team!

Remember: **Pre-commit hooks protect YOU and the team!** ✨
