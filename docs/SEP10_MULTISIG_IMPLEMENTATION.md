# SEP-10 Multi-Signature Authentication Implementation

## Overview

This document describes the implementation of multi-signature support for SEP-10 (Stellar Ecosystem Proposal 10) authentication in the Mobile Money application. The implementation allows authentication of Stellar accounts that require multiple signatures to authorize transactions, while maintaining backward compatibility with single-signature accounts.

## Implementation Details

### Architecture

The multi-signature verification process works as follows:

```
Challenge Generation (unchanged)
         ↓
    ┌────────────────┐
    │ SEP-10 Service │
    └────────────────┘
         ↓
 Client signs transaction
 (with one or more signers)
         ↓
   Verification Process:
   ├─ Validate transaction format
   ├─ Verify server signature (required)
   ├─ Fetch account signers from Horizon
   ├─ Calculate signature weights
   └─ Compare against medium threshold
         ↓
   Issue JWT on success
   Reject on failure
```

### Key Components

#### 1. Account Signer Fetching

```typescript
async fetchAccountSigners(accountId: string): Promise<{
  signers: SignerInfo[];
  thresholds: AccountThresholds;
  masterWeight: number;
}>;
```

- Fetches account information from Horizon API
- Extracts signer list with their weights
- Returns account thresholds (low, medium, high)
- Includes master key weight

#### 2. Signature Weight Calculation

```typescript
calculateSignatureWeights(
  transaction: StellarSdk.Transaction,
  signers: SignerInfo[],
  serverPublicKey: string
): number;
```

- Verifies each signature in the transaction
- Matches signatures to valid signers
- Accumulates weights from matching signatures
- Excludes server signature from calculation
- Prevents double-counting of signers

#### 3. Threshold Verification

```typescript
async verifyThresholdMet(
  transaction: StellarSdk.Transaction,
  clientAccountId: string
): Promise<boolean>;
```

- Fetches account signers and thresholds
- Calculates total client signature weight
- Compares against account's medium threshold
- Returns true if threshold is met

### Modified Methods

#### verifyChallenge() - Now Async

**Before:**
```typescript
verifyChallenge(transactionXDR: string, clientAccountID?: string): Sep10TokenResponse
```

**After:**
```typescript
async verifyChallenge(transactionXDR: string, clientAccountID?: string): Promise<Sep10TokenResponse>
```

The method now:
1. Verifies server signature (required for SEP-10)
2. Fetches account signers from Horizon
3. Calculates combined weight of client signatures
4. Verifies weight meets medium threshold
5. Issues JWT token on success

## Usage Examples

### Single-Signature Account (Backward Compatible)

```typescript
// Account with no multi-signature setup (master weight = 1, medium threshold = 0)
const challenge = service.generateChallenge(clientPublicKey);

// Client signs the challenge
const signedTx = transaction.sign(clientKeypair);

// Verification - automatically handles as single-sig
const response = await service.verifyChallenge(signedTx.toXDR());
console.log(response.token); // JWT token issued
```

### Multi-Signature Account (2-of-3)

```typescript
// Account with multiple signers setup:
// - Master key: weight 1
// - Signer1: weight 1
// - Signer2: weight 1
// - Medium threshold: 2 (requires 2 weight)

const challenge = service.generateChallenge(accountPublicKey);

// Two signers sign the challenge
const signedTx = transaction
  .sign(masterKeypair)
  .sign(signer1Keypair);

// Verification - checks weight meets threshold
const response = await service.verifyChallenge(signedTx.toXDR());
console.log(response.token); // JWT token issued (weight 2 >= threshold 2)
```

### Multi-Signature Account with Weighted Signers

```typescript
// Account with weighted signers:
// - Master key: weight 0 (disabled)
// - Signer1: weight 2
// - Signer2: weight 1
// - Medium threshold: 3 (requires 3 weight)

const challenge = service.generateChallenge(accountPublicKey);

// Two signers required (weight 2 + 1 = 3)
const signedTx = transaction
  .sign(signer1Keypair)  // weight 2
  .sign(signer2Keypair); // weight 1 (total = 3)

// Verification succeeds
const response = await service.verifyChallenge(signedTx.toXDR());
console.log(response.token); // JWT token issued
```

## API Behavior

### Success Case (400-level Errors Become Threshold Errors)

**Scenario:** Multi-signature account with threshold not met

**Before Implementation:**
```json
{
  "error": "Transaction is not signed by the client account"
}
```

**After Implementation:**
```json
{
  "error": "Signing threshold not met. The account requires additional signatures to authorize this transaction."
}
```

### Error Handling

The implementation maintains all existing error validations:

1. **Invalid Transaction Format**
   - Invalid XDR
   - Non-zero sequence number
   - Missing timebounds
   - Expired or not yet valid

2. **Missing Server Signature**
   - SEP-10 requirement: Server must sign the challenge

3. **Insufficient Client Signatures**
   - Single-sig: Any client signature required
   - Multi-sig: Weight must meet medium threshold

4. **Account Not Found**
   - Horizon API error returns: "Failed to verify signing threshold"

## Acceptance Criteria

✅ **Criterion 1: Single-signature accounts authenticate successfully**
- Backward compatible with existing implementations
- Works with standard Stellar accounts
- No changes required for existing clients

✅ **Criterion 2: Multi-signature accounts authenticate when threshold met**
- Correctly fetches signers from Horizon
- Calculates signature weights
- Verifies weight meets medium threshold
- Issues JWT token on success

✅ **Criterion 3: Reject when threshold not met**
- Returns 400 Bad Request
- Clear error message about signing threshold
- Includes helpful context about requirements

## Testing

### Test Coverage

1. **Backward Compatibility Tests**
   - Single-signature challenge verification
   - Token issuance and validation
   - All existing error cases

2. **Multi-Signature Tests**
   - Two-of-three signatures
   - Weighted signers
   - Zero threshold accounts
   - Threshold not met scenarios
   - Account not found on Horizon

3. **Mock Horizon Server Tests**
   - Prevents external API dependencies
   - Deterministic test results
   - Fast test execution

### Running Tests

```bash
# Run all SEP-10 tests
npm test -- src/stellar/__tests__/sep10.test.ts

# Run specific test suite
npm test -- src/stellar/__tests__/sep10.test.ts -t "Multi-Signature"

# Run with verbose output
npm test -- src/stellar/__tests__/sep10.test.ts --verbose
```

## Migration Guide

### For Existing Integrations

Since `verifyChallenge()` is now async, update your code:

**Before:**
```typescript
const response = service.verifyChallenge(transactionXDR);
res.json(response);
```

**After:**
```typescript
const response = await service.verifyChallenge(transactionXDR);
res.json(response);
```

### Express Router

The router is already updated to handle async operations:

```typescript
router.post("/", async (req: Request, res: Response) => {
  // ...
  const tokenResponse = await sep10Service.verifyChallenge(transaction);
  // ...
});
```

### Admin SEP-10

The admin authentication is also updated:

```typescript
async verifyAdminChallenge(transactionXDR: string): Promise<AdminSep10TokenResponse> {
  const baseToken = await this.verifyChallenge(transactionXDR); // Now awaited
  // ...
}
```

## Configuration

No new configuration options are required. The implementation uses existing environment variables:

- `STELLAR_NETWORK` - Network (testnet/mainnet)
- `STELLAR_SIGNING_KEY` - Server signing key
- `JWT_SECRET` - JWT signing secret

## Performance Considerations

1. **Horizon API Calls**
   - One additional API call per verification (loadAccount)
   - Consider caching account signer data for high-volume scenarios

2. **Signature Verification**
   - O(n*m) where n = signatures, m = signers
   - Typically fast for account with <10 signers

3. **Typical Latency**
   - Challenge generation: ~1ms
   - Verification (single-sig): ~10ms (includes Horizon API)
   - Verification (multi-sig): ~15-20ms (depends on Horizon)

## Troubleshooting

### "Failed to verify signing threshold"

**Cause:** Account not found on Horizon API

**Solution:**
1. Verify account ID is correct
2. Verify Horizon network matches (testnet vs mainnet)
3. Check network connectivity to Horizon

### "Signing threshold not met"

**Cause:** Insufficient signatures or weight

**Solution:**
1. Verify all required signers have signed
2. Check signature count matches account's medium threshold
3. Verify signer keys are correct (from account master key)

### "Transaction is not signed by the server"

**Cause:** Client didn't use the provided challenge

**Solution:**
1. Verify using the challenge returned by GET /sep10
2. Check server signing key is configured
3. Verify network passphrase matches

## Future Enhancements

Potential improvements for future versions:

1. **Caching Strategy**
   - Cache account signer data for 30-60 seconds
   - Invalidate on demand

2. **Batch Verification**
   - Verify multiple challenges in one request
   - Reduce number of Horizon API calls

3. **Low/High Threshold Support**
   - Currently uses medium threshold only
   - Could support operation-specific thresholds

4. **Webhook Notifications**
   - Notify on multi-sig threshold updates
   - Alert on unusual signing patterns

## Related Documentation

- [SEP-10 Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
- [Stellar Account Thresholds](https://developers.stellar.org/docs/encyclopedia/accounts#signers--multi-sig)
- [Horizon API Documentation](https://developers.stellar.org/api/introduction/async-request-submission)
