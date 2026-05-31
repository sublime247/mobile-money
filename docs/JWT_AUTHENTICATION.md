# JWT Authentication Documentation

## Overview

This application uses JSON Web Tokens (JWT) for authentication and authorization of API endpoints. JWT tokens provide a secure way to verify user identity and protect sensitive routes.

## Setup

### Environment Variables

Add the following to your `.env` file:

```env
JWT_SECRET=your_super_secret_jwt_key_change_this_in_production
```

**Important**: Use a strong, unique secret key in production environments.

## Token Generation

### Function: `generateToken(payload)`

Creates a JWT token with user information.

```typescript
import { generateToken } from "../auth/jwt";

const token = generateToken({
  userId: "123",
  email: "user@example.com",
});
```

**Payload Structure:**

```typescript
{
  userId: string; // User's unique identifier
  email: string; // User's email address
}
```

**Token Expiration:** 1 hour from generation time

## Token Verification

### Function: `verifyToken(token)`

Validates a JWT token and returns the decoded payload.

```typescript
import { verifyToken } from "../auth/jwt";

try {
  const payload = verifyToken(token);
  console.log("User ID:", payload.userId);
  console.log("Email:", payload.email);
} catch (error) {
  console.error("Invalid token:", error.message);
}
```

**Returned Payload:**

```typescript
{
  userId: string;
  email: string;
  iat: number; // Issued at timestamp
  exp: number; // Expiration timestamp
}
```

## Authentication Middleware

### `authenticateToken`

Protects routes by requiring a valid JWT token in the `Authorization` header.

**Usage:**

```typescript
import { authenticateToken } from "../middleware/auth";

router.post("/protected-route", authenticateToken, handler);
```

**Header Format:**

```
Authorization: Bearer <jwt_token>
```

**Error Responses:**

- `401` - No token provided
- `401` - Token expired
- `401` - Invalid token
- `401` - Malformed token

### `optionalAuthentication`

Attaches user information if a valid token is present, but doesn't block requests without tokens.

**Usage:**

```typescript
import { optionalAuthentication } from "../middleware/auth";

router.get("/public-route", optionalAuthentication, handler);
```

## Protected Routes

The following endpoints require JWT authentication:

### Transaction Routes

- `POST /api/transactions/deposit`
- `POST /api/transactions/withdraw`
- `GET /api/transactions/:id`
- `PATCH /api/transactions/:id/notes`
- `GET /api/transactions/search`

### Bulk Transaction Routes

- `POST /api/transactions/bulk`
- `GET /api/transactions/bulk/:jobId`

## Error Handling

### Token Expired

```json
{
  "error": "Token expired",
  "message": "Please log in again"
}
```

### Invalid Token

```json
{
  "error": "Invalid token",
  "message": "Token is malformed or tampered with"
}
```

### No Token

```json
{
  "error": "Access denied",
  "message": "No token provided"
}
```

## Security Best Practices

1. **Use HTTPS**: Always transmit JWT tokens over HTTPS connections
2. **Short Expiration**: Tokens expire after 1 hour for security
3. **Secret Rotation**: Regularly rotate your JWT_SECRET in production
4. **Token Storage**: Store tokens securely on the client side (httpOnly cookies recommended)
5. **Revocation**: Implement token revocation if needed for immediate logout

## Example Usage

### Client-Side Implementation

```javascript
// Login and store token
async function login(email, password) {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const { token } = await response.json();
  localStorage.setItem("jwt_token", token);
}

// Make authenticated request
async function getTransaction(id) {
  const token = localStorage.getItem("jwt_token");

  const response = await fetch(`/api/transactions/${id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return response.json();
}
```

### Server-Side Handler Example

```typescript
import { Request, Response } from "express";

export async function getUserTransactions(req: Request, res: Response) {
  // User information is available via req.jwtUser (set by middleware)
  const userId = req.jwtUser?.userId;

  if (!userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  // Fetch user transactions
  const transactions = await getTransactionsByUserId(userId);
  res.json(transactions);
}
```

## Testing

Use the following test token for development (replace with your actual JWT_SECRET):

```bash
# Generate test token (node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { userId: 'test-user-123', email: 'test@example.com' },
  'your_super_secret_jwt_key_change_this_in_production',
  { expiresIn: '1h' }
);
console.log(token);
")
```

## Troubleshooting

### Common Issues

1. **"JWT_SECRET is not defined"**
   - Ensure JWT_SECRET is set in your environment variables

2. **"Token has expired"**
   - Tokens expire after 1 hour, implement token refresh logic

3. **"Invalid token"**
   - Check that the token hasn't been modified
   - Ensure the Authorization header format is correct

4. **CORS issues**
   - Ensure your frontend is configured to send the Authorization header

## Migration Notes

This JWT implementation replaces the previous admin API key authentication for protected routes. The existing `requireAuth` middleware (using X-API-Key) is still available for admin endpoints.
