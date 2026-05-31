# Pact Contract Testing — Quick Start

Get up and running with Pact contract tests in 5 minutes.

## Step 1: Fix PowerShell Execution Policy (Windows Only)

If you're on Windows and see execution policy errors:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

## Step 2: Run the Tests

```bash
npm run test:pact
```

This will:

- Run all Pact contract tests (MTN, Airtel, Orange)
- Generate pact files in `pacts/` directory
- Verify our service matches expected provider APIs

## Step 3: Check the Results

After tests pass, check the generated contracts:

```bash
ls pacts/
```

You should see:

- `MobileMoneyService-MTNMoMoAPI.json`
- `MobileMoneyService-AirtelMoneyAPI.json`
- `MobileMoneyService-OrangeMoneyAPI.json`

## Step 4: Review a Pact File

Open any pact file to see the documented contract:

```bash
cat pacts/MobileMoneyService-MTNMoMoAPI.json
```

The file contains:

- All API interactions (requests/responses)
- Expected headers, bodies, status codes
- Provider states and conditions

## What's Next?

### For Developers

- **Update mocks**: Ensure `src/services/mobilemoney/providers/mock.ts` matches contracts
- **Add new interactions**: When adding features, update pact tests first
- **Run before commits**: Add `npm run test:pact` to your pre-commit hook

### For DevOps

- **Add to CI**: Include pact tests in your CI pipeline
- **Share contracts**: Send pact files to provider teams for verification
- **Monitor drift**: Set up alerts when contracts change

### For QA

- **Use as documentation**: Pact files document exact API behavior
- **Verify staging**: Compare staging API responses to pact contracts
- **Test edge cases**: Add pact tests for error scenarios

## Common Commands

```bash
# Run all pact tests
npm run test:pact

# Run specific provider
npx jest tests/pact/mtn.pact.test.ts --config jest.pact.config.js

# Run with verbose output
npm run test:pact -- --verbose

# Clean pact files and regenerate
rm -rf pacts/*.json && npm run test:pact
```

## Troubleshooting

### "Port already in use"

Tests run serially to avoid port conflicts. If you still see this error, kill any processes using the port:

```bash
# Windows
netstat -ano | findstr :XXXX
taskkill /PID <PID> /F

# Linux/Mac
lsof -ti:XXXX | xargs kill -9
```

### "Cannot find module @pact-foundation/pact"

Install dependencies:

```bash
npm install
```

### Tests timeout

Increase timeout in `jest.pact.config.js`:

```javascript
testTimeout: 60000, // 60 seconds
```

## Learn More

- **Full documentation**: See `docs/PACT_CONTRACT_TESTING.md`
- **Test examples**: Review `tests/pact/*.pact.test.ts`
- **Pact docs**: https://docs.pact.io/

## Need Help?

1. Check `tests/pact/README.md` for detailed info
2. Review `docs/PACT_CONTRACT_TESTING.md` for architecture
3. Open an issue in the repository
