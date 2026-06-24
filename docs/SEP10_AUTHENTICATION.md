# SEP-10: Stellar Authentication

## Overview

This implementation provides SEP-10 authentication for the mobile-money platform, allowing users to authenticate using their Stellar accounts. SEP-10 is a Stellar Ecosystem Proposal that defines a standard way to authenticate users using their Stellar account addresses.

## Multi-Signature Support

As of the latest update, the SEP-10 implementation supports **multi-signature Stellar accounts**. This allows accounts with multiple signers to authenticate successfully when the combined weight of their signatures meets the account's medium threshold.

For detailed information about the multi-signature implementation, see [SEP10_MULTISIG_IMPLEMENTATION.md](./SEP10_MULTISIG_IMPLEMENTATION.md).

## Specification

- **SEP-10**: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
- **Network**: Stellar Testnet (configurable for Mainnet)

## How It Works

SEP-10 authentication follows a challenge-response flow:

1. **Client Request**: Client requests a challenge transaction from the server
2. **Server Challenge**: Server generates a challenge transaction with a random memo
3. **Client Signing**: Client signs the transaction with their Stellar account
4. **Server Verification**: Server verifies the signature and issues a JWT token
5. **Authentication**: Client uses the JWT token for subsequent API requests

## API Endpoints

### GET /sep10/auth

Request a challenge transaction for authentication.

**Query Parameters:**

- `account` (required): Stellar public key of the client (e.g., `GABC...`)
- `home_domain` (optional): Home domain of the server
- `client_domain` (optional): Client's domain
- `memo` (optional): Memo to include in the challenge

**Example Request:**

```bash
curl "https://api.mobilemoney.com/sep10/auth?account=GABC123..."
```

**Example Response:**

```json
{
  "transaction": "AAAAAgAAAAB...",
  "network_passphrase": "Test SDF Network ; September 2015"
}
```

### POST /sep10/auth

Verify a signed challenge transaction and receive a JWT token.

**Request Body:**

```json
{
  "transaction": "AAAAAgAAAAB..."
}
```

**Example Response:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

## Implementation Details

### Challenge Transaction Generation

The challenge transaction is built with the following components:

1. **Server Account**: The server's Stellar account used to sign the challenge
2. **Client Account**: The client's Stellar account (source account for manageData operation)
3. **ManageData Operation**: Contains the authentication challenge
4. **Memo**: Random UUID to prevent replay attacks
5. **Timebounds**: Transaction expires after 5 minutes (300 seconds)

```typescript
const transaction = new StellarSdk.TransactionBuilder(serverAccount, {
  fee: MAX_FEE.toString(),
  networkPassphrase: this.networkPassphrase,
})
  .addOperation(
    StellarSdk.Operation.manageData({
      source: account,
      name: `${getHomeDomain()} auth`,
      value: memoId,
    }),
  )
  .addMemo(StellarSdk.Memo.text(memoId))
  .setTimeout(CHALLENGE_EXPIRY_SECONDS)
  .build();
```

### Transaction Verification

The verification process includes:

1. **XDR Parsing**: Parse the transaction from XDR format
2. **Server Signature**: Verify the transaction is signed by the server
3. **Client Signature**: Verify the transaction is signed by the client
4. **Expiration Check**: Verify the transaction has not expired
5. **Operation Validation**: Ensure the transaction contains a manageData operation

```typescript
// Verify server signature
const isServerSigned = transaction.signatures.some((sig) => {
  const txHash = transaction.hash();
  return serverKeypair.verify(txHash, sig.signature());
});

// Verify client signature
const isClientSigned = transaction.signatures.some((sig) => {
  const txHash = transaction.hash();
  return clientKeypair.verify(txHash, sig.signature());
});
```

### JWT Token Issuance

Upon successful verification, a JWT token is issued with the following claims:

```typescript
const payload = {
  iss: homeDomain, // Issuer (server domain)
  sub: clientPublicKey, // Subject (client's Stellar public key)
  iat: Math.floor(Date.now() / 1000), // Issued at
  exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS, // Expiration
  jti: uuidv4(), // JWT ID (unique identifier)
};
```

**Token Expiration**: 24 hours (86400 seconds)

## Configuration

### Environment Variables

Add the following to your `.env` file:

```bash
# Stellar SEP-10 Configuration
STELLAR_SIGNING_KEY=your_stellar_secret_key_here
STELLAR_HOME_DOMAIN=api.mobilemoney.com
JWT_SECRET=your_jwt_secret_here

# Stellar Network Configuration
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
```

### Required Variables

- `STELLAR_SIGNING_KEY`: The secret key of the server's Stellar account used to sign challenge transactions
- `STELLAR_HOME_DOMAIN`: The domain of the server (used in JWT issuer claim)
- `JWT_SECRET`: Secret key for signing JWT tokens

### Optional Variables

- `STELLAR_NETWORK`: Stellar network to use (testnet or mainnet)
- `STELLAR_HORIZON_URL`: Horizon server URL (defaults to testnet)

## Security Considerations

### Challenge Transaction Security

1. **Random Memo**: Each challenge includes a random UUID to prevent replay attacks
2. **Timebounds**: Transactions expire after 5 minutes to limit the window for attacks
3. **Server Signature**: Transactions must be signed by the server to prevent forgery
4. **Client Signature**: Transactions must be signed by the client to prove ownership

### JWT Token Security

1. **Expiration**: Tokens expire after 24 hours
2. **Unique ID**: Each token has a unique JWT ID (jti) for tracking
3. **HS256 Algorithm**: Uses HMAC-SHA256 for token signing
4. **Secret Management**: JWT secret should be kept secure and rotated periodically

### Network Security

1. **HTTPS Required**: All SEP-10 endpoints should be served over HTTPS
2. **CORS Configuration**: Configure CORS to allow only trusted domains
3. **Rate Limiting**: Implement rate limiting to prevent abuse

## Usage Examples

### Client-Side Implementation

```javascript
// Step 1: Request challenge
const challengeResponse = await fetch(
  "https://api.mobilemoney.com/sep10/auth?account=GABC123...",
);
const { transaction, network_passphrase } = await challengeResponse.json();

// Step 2: Sign the transaction with Stellar wallet
const signedTransaction = await stellarWallet.sign(transaction);

// Step 3: Verify and get JWT token
const verifyResponse = await fetch("https://api.mobilemoney.com/sep10/auth", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ transaction: signedTransaction }),
});
const { token } = await verifyResponse.json();

// Step 4: Use JWT token for authenticated requests
const apiResponse = await fetch(
  "https://api.mobilemoney.com/api/transactions",
  {
    headers: { Authorization: `Bearer ${token}` },
  },
);
```

### Server-Side Usage

```typescript
import { sep10Service } from "./stellar/sep10";

// Generate challenge
const challenge = await sep10Service.generateChallenge({
  account: "GABC123...",
  home_domain: "api.mobilemoney.com",
});

// Verify challenge and issue token
const tokenResponse = await sep10Service.verifyChallenge({
  transaction: signedTransactionXDR,
});

// Verify JWT token
const decoded = sep10Service.verifyToken(token);
console.log(decoded.sub); // Client's Stellar public key
```

## Testing

### Test with curl

```bash
# Step 1: Get challenge
curl "http://localhost:3000/sep10/auth?account=GABC123..."

# Step 2: Sign transaction (using Stellar CLI or SDK)
# ...

# Step 3: Verify and get token
curl -X POST http://localhost:3000/sep10/auth \
  -H "Content-Type: application/json" \
  -d '{"transaction": "AAAAAgAAAAB..."}'
```

### Test with Stellar Laboratory

1. Go to https://laboratory.stellar.org
2. Create a new transaction
3. Paste the challenge transaction XDR
4. Sign with your Stellar account
5. Submit the signed transaction to the verify endpoint

## Error Handling

### Common Errors

| Error                                     | Description                               | Solution                          |
| ----------------------------------------- | ----------------------------------------- | --------------------------------- |
| `Invalid Stellar account address`         | Account is not a valid Stellar public key | Verify the account address format |
| `Invalid transaction XDR`                 | Transaction XDR is malformed              | Verify the transaction XDR format |
| `Transaction is not signed by the server` | Server signature is missing               | Ensure server signs the challenge |
| `Transaction is not signed by the client` | Client signature is missing               | Ensure client signs the challenge |
| `Challenge transaction has expired`       | Transaction timebounds exceeded           | Request a new challenge           |
| `STELLAR_SIGNING_KEY not set`             | Server configuration error                | Set the environment variable      |
| `JWT_SECRET not set`                      | Server configuration error                | Set the environment variable      |

### Error Response Format

```json
{
  "error": "Error message describing what went wrong"
}
```

## Integration with Existing Auth

SEP-10 authentication can be used alongside existing authentication methods:

1. **JWT Token**: SEP-10 issues JWT tokens compatible with existing JWT middleware
2. **Stellar Account**: The `sub` claim contains the client's Stellar public key
3. **Middleware**: Existing JWT verification middleware can be used

### Example Middleware

```typescript
import { Request, Response, NextFunction } from "express";
import { sep10Service } from "./stellar/sep10";

export function authenticateSep10(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing authorization header" });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = sep10Service.verifyToken(token);
    req.user = { stellarAddress: decoded.sub };
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
```

## Performance Considerations

1. **Caching**: Challenge transactions can be cached briefly to reduce Horizon API calls
2. **Connection Pooling**: Use connection pooling for database operations
3. **Async Operations**: All operations are asynchronous for better performance
4. **Rate Limiting**: Implement rate limiting to prevent abuse

## Compliance

SEP-10 authentication provides:

1. **Decentralized Authentication**: No central password database
2. **Cryptographic Proof**: Authentication is proven via Stellar signatures
3. **Interoperability**: Works with any Stellar wallet or SDK
4. **Standards Compliance**: Follows Stellar Ecosystem Proposal 10

## Troubleshooting

### Challenge Generation Fails

**Symptoms**: GET /sep10/auth returns 500 error

**Possible Causes**:

- `STELLAR_SIGNING_KEY` not set
- Invalid Stellar secret key
- Horizon API connection failure

**Solutions**:

1. Verify environment variables are set correctly
2. Check Stellar secret key format
3. Verify Horizon API connectivity

### Verification Fails

**Symptoms**: POST /sep10/auth returns 400 error

**Possible Causes**:

- Transaction not signed by client
- Transaction not signed by server
- Transaction expired

**Solutions**:

1. Ensure client signs the transaction
2. Ensure server signs the transaction before sending
3. Request a new challenge if expired

### JWT Token Invalid

**Symptoms**: API requests return 401 Unauthorized

**Possible Causes**:

- Token expired
- Invalid token signature
- Wrong JWT secret

**Solutions**:

1. Request a new token via SEP-10 flow
2. Verify JWT secret matches between services
3. Check token expiration time

## References

- [SEP-10 Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
- [Stellar SDK Documentation](https://stellar.github.io/js-stellar-sdk/)
- [Stellar Laboratory](https://laboratory.stellar.org)
- [Stellar Network Passphrases](https://developers.stellar.org/docs/glossary/network-passphrase/)
