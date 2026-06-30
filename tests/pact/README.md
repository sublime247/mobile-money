# Pact Contract Tests for Provider APIs

This directory contains consumer-driven contract tests using [Pact](https://docs.pact.io/) to ensure our mock servers and test fixtures exactly match the real provider APIs (MTN, Airtel, Orange).

## What is Contract Testing?

Contract testing verifies that the consumer (our service) and provider (MTN/Airtel/Orange APIs) agree on the API contract. This prevents "staging vs prod" bugs where mocks work in tests but the real API behaves differently.

## Benefits

- **High confidence in mocks**: Generated pact files document the exact API contract
- **Catch breaking changes early**: If a provider changes their API, tests fail immediately
- **Living documentation**: Pact files serve as executable API documentation
- **Provider verification**: Pact files can be shared with providers to verify their side

## Running the Tests

### Prerequisites

Ensure you have the dependencies installed:

```bash
npm install
```

### Run All Pact Tests

```bash
npm run test:pact
```

This runs all contract tests in serial mode (to avoid port conflicts from Pact mock servers).

### Run Individual Provider Tests

```bash
# MTN only
npx jest tests/pact/mtn.pact.test.ts --config jest.pact.config.js

# Airtel only
npx jest tests/pact/airtel.pact.test.ts --config jest.pact.config.js

# Orange only
npx jest tests/pact/orange.pact.test.ts --config jest.pact.config.js
```

### PowerShell Execution Policy (Windows)

If you encounter execution policy errors on Windows, run:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Or use the full path to node:

```bash
node node_modules/jest/bin/jest.js --config jest.pact.config.js
```

## Generated Pact Files

After running the tests, pact files are generated in `pacts/`:

- `MobileMoneyService-MTNMoMoAPI.json`
- `MobileMoneyService-AirtelMoneyAPI.json`
- `MobileMoneyService-OrangeMoneyAPI.json`

These JSON files contain the complete API contract and can be:

1. **Committed to version control** for documentation
2. **Shared with provider teams** for verification
3. **Used in CI/CD** to catch breaking changes

## Test Coverage

### MTN MoMo API (`mtn.pact.test.ts`)

- ✅ OAuth2 token authentication
- ✅ Collection (requesttopay) — initiate payment
- ✅ Transaction status check (SUCCESSFUL, FAILED, PENDING)
- ✅ Disbursement operational balance

### Airtel Money API (`airtel.pact.test.ts`)

- ✅ OAuth2 token authentication
- ✅ Collection (merchant payments) — request payment
- ✅ Transaction status check (TS=success, TF=failed, TP=pending)
- ✅ Disbursement (payouts)
- ✅ Operational balance query

### Orange Money API (`orange.pact.test.ts`)

- ✅ OAuth2 client credentials authentication
- ✅ Collection (payments/collect) — request payment
- ✅ Disbursement (payments/disburse) — send payout
- ✅ Transaction status check (COMPLETED, FAILED, PENDING)
- ✅ Error scenarios (401 unauthorized, 404 not found)

## Updating Contracts

When provider APIs change:

1. Update the corresponding test file (`mtn.pact.test.ts`, etc.)
2. Run `npm run test:pact` to regenerate pact files
3. Commit the updated pact files
4. Update mock implementations in `src/services/mobilemoney/providers/` to match

## Integration with Existing Tests

Pact tests are **separate** from unit tests:

- **Unit tests** (`npm test`) use `jest.config.js` and mock axios
- **Pact tests** (`npm run test:pact`) use `jest.pact.config.js` and Pact mock servers

This separation ensures:

- Fast unit test execution (no Pact overhead)
- Isolated contract verification
- No port conflicts

## CI/CD Integration

Add to your CI pipeline:

```yaml
# .github/workflows/test.yml
- name: Run Pact Contract Tests
  run: npm run test:pact

- name: Upload Pact Files
  uses: actions/upload-artifact@v3
  with:
    name: pact-contracts
    path: pacts/
```

## Troubleshooting

### Port Already in Use

Pact mock servers bind to random ports. If you see port conflicts, ensure:

- Tests run serially (`maxWorkers: 1` in `jest.pact.config.js`)
- No other services are using the port range

### Pact Files Not Generated

Check that:

- The `pacts/` directory exists (created automatically)
- Tests are passing (pact files only generate on success)
- You have write permissions in the project directory

### Matcher Errors

Pact uses matchers like `like()`, `regex()`, `string()` to define flexible contracts:

- `like(value)` — matches type, not exact value
- `regex(pattern, example)` — matches pattern
- `string(example)` — matches any string

See [Pact Matchers docs](https://docs.pact.io/implementation_guides/javascript/docs/matching) for details.

## Next Steps

1. **Run the tests**: `npm run test:pact`
2. **Review generated pacts**: Check `pacts/*.json` files
3. **Update mocks**: Ensure `src/services/mobilemoney/providers/mock.ts` matches contracts
4. **Share with providers**: Send pact files to MTN/Airtel/Orange for verification
5. **Add to CI**: Integrate into your CI/CD pipeline

## Resources

- [Pact Documentation](https://docs.pact.io/)
- [Pact JS Guide](https://docs.pact.io/implementation_guides/javascript)
- [Contract Testing Best Practices](https://docs.pact.io/getting_started/how_pact_works)
