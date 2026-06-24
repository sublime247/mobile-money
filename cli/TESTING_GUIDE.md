# CLI Configuration Profiles - Testing Guide

## ✅ Assignment Completion Verification

This guide provides step-by-step instructions to verify that the CLI Configuration Profiles feature has been successfully implemented and is working correctly.

---

## Prerequisites

Before starting, ensure:
- Node.js 20+ is installed
- You're in the `/workspaces/mobile-money/cli` directory
- You've run `npm install` in the cli directory

---

## Test Steps

### Step 1: Verify CLI Compilation

**Objective**: Ensure the TypeScript code compiles without errors

```bash
cd /workspaces/mobile-money/cli
npm run build
```

**Expected Output**:
- No compilation errors
- `dist/` folder is created with compiled JavaScript files

**✓ Pass Criteria**: Build completes successfully

---

### Step 2: Verify Profile Command Registration

**Objective**: Confirm the profile command is registered and accessible

```bash
npm run dev -- profile --help
```

**Expected Output**:
```
Usage: momo-cli profile [options] [command]

Manage configuration profiles (Dev/Staging/Production)

Options:
  -h, --help             display help for command

Commands:
  save [options] <name>  Save a new configuration profile
  use <name>             Switch to a configuration profile
  list                   List all saved profiles
  delete <name>          Delete a configuration profile
  help [command]         display help for command
```

**✓ Pass Criteria**: All profile subcommands are shown

---

### Step 3: Test Profile Saving

**Objective**: Save multiple configuration profiles for different environments

```bash
# Save development profile
npm run dev -- profile save dev --url http://localhost:3000 --key dev-api-key-12345

# Save staging profile
npm run dev -- profile save staging --url https://staging-api.example.com --key staging-api-key-67890

# Save production profile
npm run dev -- profile save production --url https://api.example.com --key prod-api-key-98765
```

**Expected Output** (for each command):
```
✓ Profile "dev" saved successfully
✓ Profile "staging" saved successfully
✓ Profile "production" saved successfully
```

**✓ Pass Criteria**: All three profiles are saved without errors

---

### Step 4: Test Profile Listing

**Objective**: List all saved profiles and verify no profile is marked as active

```bash
npm run dev -- profile list
```

**Expected Output**:
```
Available profiles:
  dev — http://localhost:3000 (dev-api-...)
  staging — https://staging-api.example.com (staging-...)
  production — https://api.example.com (prod-api-...)

⚠ No active profile or environment variables set
```

**✓ Pass Criteria**: All three profiles are listed correctly

---

### Step 5: Test Profile Switching (Use Command)

**Objective**: Switch to a profile and verify it becomes active

```bash
# Switch to development profile
npm run dev -- profile use dev
```

**Expected Output**:
```
✓ Switched to profile "dev"
  URL: http://localhost:3000
  Key: dev-api-...
```

**✓ Pass Criteria**: Successfully switched to dev profile

---

### Step 6: Test Active Profile Display

**Objective**: Verify the active profile is marked with "← active"

```bash
npm run dev -- profile list
```

**Expected Output**:
```
Available profiles:
  dev ← active — http://localhost:3000 (dev-api-...)
  staging — https://staging-api.example.com (staging-...)
  production — https://api.example.com (prod-api-...)
```

**✓ Pass Criteria**: dev profile shows "← active" marker

---

### Step 7: Test Profile Switching Between Environments

**Objective**: Switch between different profiles to simulate environment changes

```bash
# Switch to staging
npm run dev -- profile use staging

# Verify listing
npm run dev -- profile list
```

**Expected Output** (after using staging):
```
✓ Switched to profile "staging"
  URL: https://staging-api.example.com
  Key: staging-...

# After list:
Available profiles:
  dev — http://localhost:3000 (dev-api-...)
  staging ← active — https://staging-api.example.com (staging-...)
  production — https://api.example.com (prod-api-...)
```

**✓ Pass Criteria**: Successfully switched to staging and active marker updated

---

### Step 8: Test Production Profile Switching

**Objective**: Switch to production profile

```bash
npm run dev -- profile use production
npm run dev -- profile list
```

**Expected Output**:
```
✓ Switched to profile "production"
  URL: https://api.example.com
  Key: prod-api-...

# After list:
Available profiles:
  dev — http://localhost:3000 (dev-api-...)
  staging — https://staging-api.example.com (staging-...)
  production ← active — https://api.example.com (prod-api-...)
```

**✓ Pass Criteria**: Successfully switched to production

---

### Step 9: Test Profile Deletion

**Objective**: Delete a profile and verify it's removed

```bash
# Delete staging profile
npm run dev -- profile delete staging

# Verify it's removed
npm run dev -- profile list
```

**Expected Output**:
```
✓ Profile "staging" deleted successfully

# After list:
Available profiles:
  dev — http://localhost:3000 (dev-api-...)
  production ← active — https://api.example.com (prod-api-...)
```

**✓ Pass Criteria**: Staging profile is removed from the list

---

### Step 10: Test Error Handling - Non-existent Profile

**Objective**: Verify error handling when using a non-existent profile

```bash
npm run dev -- profile use nonexistent
```

**Expected Output**:
```
✗ Profile "nonexistent" not found
```

**✓ Pass Criteria**: Proper error message for non-existent profile

---

### Step 11: Test Error Handling - Delete Non-existent Profile

**Objective**: Verify error handling when deleting a non-existent profile

```bash
npm run dev -- profile delete nonexistent
```

**Expected Output**:
```
✗ Profile "nonexistent" not found
```

**✓ Pass Criteria**: Proper error message

---

### Step 12: Test Persistence

**Objective**: Verify profiles persist across CLI invocations

```bash
# List profiles (should show dev and production as active)
npm run dev -- profile list
```

**Expected Output**:
```
Available profiles:
  dev — http://localhost:3000 (dev-api-...)
  production ← active — https://api.example.com (prod-api-...)
```

**✓ Pass Criteria**: Profiles and active profile selection persist

---

### Step 13: Verify Data File

**Objective**: Inspect the profiles storage file

```bash
cat /workspaces/mobile-money/cli/.momo-profiles.json
```

**Expected Output** (sample):
```json
{
  "profiles": [
    {
      "name": "dev",
      "apiUrl": "http://localhost:3000",
      "apiKey": "dev-api-key-12345"
    },
    {
      "name": "production",
      "apiUrl": "https://api.example.com",
      "apiKey": "prod-api-key-98765"
    }
  ],
  "activeProfile": "production"
}
```

**✓ Pass Criteria**: JSON file is properly structured with correct data

---

### Step 14: Test Main Help Display

**Objective**: Verify profile command appears in main CLI help

```bash
npm run dev -- --help
```

**Expected Output** (should include):
```
Commands:
  auth                    Authentication commands
  status <transactionId>  Get transaction details
  retry <transactionId>   Force-retry a failed transaction
  profile                 Manage configuration profiles
                          (Dev/Staging/Production)
  help [command]          display help for command
```

**✓ Pass Criteria**: Profile command is visible in main help

---

### Step 15: Test Each Subcommand Help

**Objective**: Verify individual subcommand help messages

```bash
npm run dev -- profile save --help
npm run dev -- profile use --help
npm run dev -- profile list --help
npm run dev -- profile delete --help
```

**Expected Output**: Each command should show its specific help text

**✓ Pass Criteria**: All subcommands have helpful descriptions

---

## 🎯 Summary of Test Coverage

Your implementation should now pass all of the following criteria:

✅ **Profile Creation**: Save profiles with URL and API key  
✅ **Profile Switching**: Use `momo-cli profile use` to switch between environments  
✅ **Profile Listing**: Display all profiles with active profile indicator  
✅ **Profile Deletion**: Remove profiles from configuration  
✅ **Error Handling**: Proper error messages for invalid operations  
✅ **Data Persistence**: Profiles saved to `.momo-profiles.json`  
✅ **CLI Integration**: Profile command integrated with existing CLI structure  
✅ **Help Documentation**: All commands display helpful information  

---

## 🚀 Next Steps

After passing all tests:

1. **Clean up test profiles**:
   ```bash
   rm /workspaces/mobile-money/cli/.momo-profiles.json
   ```

2. **Update .momorc for production use**:
   ```bash
   echo "MOMO_API_URL=https://your-production-url" > cli/.momorc
   echo "MOMO_API_KEY=your-admin-api-key" >> cli/.momorc
   ```

3. **Build distribution version**:
   ```bash
   npm run build
   ```

4. **Commit your changes** (if using git):
   ```bash
   git add cli/
   git commit -m "feat: Enable CLI Configuration Profiles (Dev/Staging/Production)"
   ```

---

## ✨ Implementation Details

The feature was implemented with the following components:

### Modified Files:
- `cli/src/config.ts` - Added profile management functions
- `cli/src/index.ts` - Registered profile command
- `cli/README.md` - Updated documentation

### New Files:
- `cli/src/commands/profile.ts` - Profile command implementation

### Data Storage:
- `.momo-profiles.json` - JSON file storing profiles locally

### Features:
- Save separate credential profiles for different environments
- Switch between profiles using `profile use <name>`
- List all profiles with active profile indicator
- Delete profiles when no longer needed
- Error handling for invalid operations
- Persistent storage across sessions
