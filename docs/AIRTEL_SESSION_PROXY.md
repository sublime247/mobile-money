# Airtel Money Web Session Proxy Wrapper

## Overview

The Airtel Money Web Session Proxy Wrapper implements **three independent operating modes** to handle Airtel Money payouts across different deployment scenarios:

1. **DIRECT Mode** (default) - OAuth2 Bearer token authentication
2. **WEB Mode** - Web-based session login with cookie persistence
3. **PROXY Mode** - External proxy wrapper for session management

This implementation allows the service to adapt to Airtel Money's varying API requirements across different countries and regions, where some deployments require interactive session logins instead of direct REST API access.

---

## Architecture

### Three-Mode Design

```
┌─────────────────────────────────────────────────────────────┐
│                    AirtelService                            │
│                                                             │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │   DIRECT   │  │    WEB     │  │   PROXY    │           │
│  │  (OAuth2)  │  │ (Session)  │  │ (External) │           │
│  └────────────┘  └────────────┘  └────────────┘           │
│         │              │                │                   │
│         ↓              ↓                ↓                   │
│  sendPayout()  / requestPayment()  / getOperationalBalance()
└─────────────────────────────────────────────────────────────┘
```

### Mode Resolution Logic

```typescript
if (AIRTEL_PROXY_URL) {
  // Proxy mode: delegate to external service
  mode = "proxy";
} else if (AIRTEL_WEB_BASE_URL && AIRTEL_USERNAME) {
  // Web session mode: login locally, maintain cookies
  mode = "web";
} else {
  // Direct API mode: OAuth2 token auth (default)
  mode = "direct";
}
```

---

## Configuration

### DIRECT Mode (OAuth2)

Minimal configuration for standard REST API access:

```env
AIRTEL_API_KEY=your_api_key
AIRTEL_API_SECRET=your_api_secret
AIRTEL_BASE_URL=https://openapi.airtel.africa
AIRTEL_COUNTRY=NG
AIRTEL_CURRENCY=NGN
```

**When to use:**

- Standard REST API deployments
- OAuth2 token-based authentication available
- No interactive session login required

### WEB Mode (Session-Based)

Full configuration for session-based login:

```env
# Web session endpoints
AIRTEL_MODE=web
AIRTEL_WEB_BASE_URL=https://airtel-web-portal.example.com
AIRTEL_LOGIN_PATH=/login
AIRTEL_REFRESH_PATH=/session/refresh

# Portal credentials
AIRTEL_USERNAME=portal_username
AIRTEL_PASSWORD=portal_password

# Form field names (customizable)
AIRTEL_USERNAME_FIELD=username
AIRTEL_PASSWORD_FIELD=password
AIRTEL_CSRF_FIELD=_csrf

# API paths (for operations via session)
AIRTEL_PAYMENT_PATH=/merchant/v1/payments/
AIRTEL_PAYOUT_PATH=/standard/v1/disbursements/
AIRTEL_STATUS_PATH=/standard/v1/payments/:reference

# Session persistence
AIRTEL_SESSION_STORE_PATH=.airtel-session/session.json
AIRTEL_SESSION_TTL_MS=1200000
AIRTEL_REFRESH_SKEW_MS=60000
AIRTEL_MAX_ATTEMPTS=3

# Standard settings
AIRTEL_COUNTRY=NG
AIRTEL_CURRENCY=NGN
```

**When to use:**

- Airtel Money portal requires interactive login
- Direct REST API not available in region
- Session-based authentication required
- Cookie and CSRF token management needed

### PROXY Mode (External Wrapper)

Configuration for external proxy service:

```env
# Proxy endpoint
AIRTEL_PROXY_URL=https://proxy.example.com
AIRTEL_PROXY_SECRET=your-proxy-authentication-secret

# Standard settings (still used for data formatting)
AIRTEL_COUNTRY=NG
AIRTEL_CURRENCY=NGN
```

**When to use:**

- Using specialized session proxy service
- Third-party session management required
- Decoupling from backend session handling
- Scaling session management independently

---

## Implementation Details

### Session State Management

Session state is maintained in memory with optional file persistence:

```typescript
interface AirtelSessionState {
  cookies: Record<string, StoredCookie>; // Parsed Set-Cookie values
  csrfToken?: string; // Anti-CSRF token
  expiresAt: number; // Session expiry timestamp
  authenticatedAt: number; // Login timestamp
}
```

### Cookie Extraction & Serialization

**Extraction** - Captures from `Set-Cookie` response headers:

```
Set-Cookie: sessionid=abc123; Path=/; HttpOnly; Secure
Set-Cookie: lang=en; Path=/
```

**Serialization** - For subsequent requests:

```
Cookie: sessionid=abc123; lang=en
```

### CSRF Token Handling

CSRF tokens extracted from:

1. **Response headers**: `X-CSRF-Token` header
2. **Response body**: HTML form field (pattern: `name="_csrf" value="token"`)
3. **Response JSON**: `.csrf`, `._csrf`, or `.csrfToken` properties

Token sent in all subsequent requests via `X-CSRF-Token` header.

### Session Lifecycle

#### WEB Mode Session Flow

```
1. GET /login → Initial session established
   ├─ Extract cookies and CSRF token
   ├─ Parse login form
   └─ Store initial session state

2. POST /login → Authenticate with credentials
   ├─ Include cookies, CSRF token, form data
   ├─ Capture authenticated cookies
   └─ Persist to file (if AIRTEL_SESSION_STORE_PATH set)

3. Subsequent operations (sendPayout, requestPayment)
   ├─ Use cached session if valid
   ├─ Include cookies and CSRF token
   └─ Refresh if approaching expiry

4. Session refresh (optional)
   ├─ POST /session/refresh within AIRTEL_REFRESH_SKEW_MS
   ├─ Re-authenticate without re-login
   └─ Update cookie expiry

5. Session expiry handling
   ├─ 401/403 response detected
   ├─ Clear cached session
   └─ Force re-login on next request
```

### Retry Strategy

All modes implement exponential backoff retry for transient errors:

```typescript
for (attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    response = makeRequest();

    if (response.status === 401 && mode === "direct") {
      clearToken(); // Force re-auth
      continue;
    }

    if (response.status === 401 && mode === "web") {
      clearSession(); // Force re-login
      continue;
    }

    if (response.status >= 500) {
      await delay(1000 * attempt); // Exponential backoff
      continue;
    }

    return response;
  } catch (error) {
    await delay(1000 * attempt);
  }
}
```

---

## API Contract

All three modes implement the same public interface:

### `sendPayout(phoneNumber, amount, requestId?)`

**Request body format** (same across all modes):

```json
{
  "reference": "AIRTEL-PAYOUT-1700000000000",
  "payee": { "msisdn": "2348012345678" },
  "transaction": {
    "amount": 1000,
    "id": "AIRTEL-PAYOUT-1700000000000"
  }
}
```

**Response format**:

```typescript
{
  success: boolean,
  data?: unknown,
  error?: unknown,
  providerResponseTimeMs: number
}
```

### `requestPayment(phoneNumber, amount, requestId?)`

Same as `sendPayout` but with `subscriber` instead of `payee`.

### `checkStatus(reference)`

**Response**:

```typescript
{
  success: boolean,
  data?: unknown,
  error?: unknown
}
```

### `getTransactionStatus(reference)`

**Response**:

```typescript
{
  status: "completed" | "failed" | "pending" | "unknown";
}
```

**Status mapping**:

- `TS` → `"completed"`
- `TF` → `"failed"`
- `TP` → `"pending"`
- Other → `"unknown"`

### `getOperationalBalance()`

**Response**:

```typescript
{
  success: boolean,
  data?: { availableBalance: number, currency: string },
  error?: unknown
}
```

---

## Usage Examples

### Direct Mode (Production Default)

```typescript
const service = new AirtelService();

const result = await service.sendPayout("2348012345678", "5000");
// Uses OAuth2 token from AIRTEL_API_KEY/SECRET
```

### Web Mode (Regional Fallback)

```typescript
const service = new AirtelService({
  mode: "web",
  webBaseUrl: process.env.AIRTEL_WEB_BASE_URL,
  username: process.env.AIRTEL_USERNAME,
  password: process.env.AIRTEL_PASSWORD,
  sessionStorePath: ".airtel-session/session.json",
});

const result = await service.sendPayout("2348012345678", "5000");
// Logs in with credentials, maintains session cookies
// Automatically refreshes before expiry
```

### Proxy Mode (Specialized Service)

```typescript
const service = new AirtelService({
  mode: "proxy",
  proxyBaseUrl: process.env.AIRTEL_PROXY_URL,
  proxySecret: process.env.AIRTEL_PROXY_SECRET,
});

const result = await service.sendPayout("2348012345678", "5000");
// Forwards to proxy service, which handles session management
```

---

## Testing

Comprehensive test suite covers:

- **DIRECT Mode**: OAuth2 token caching, 401 handling, retry logic
- **WEB Mode**: Login flow, cookie capture, CSRF token extraction, session persistence, refresh logic
- **PROXY Mode**: Request forwarding, proxy secret headers
- **Mode Resolution**: Environment variable precedence
- **Cookie Parsing**: Set-Cookie header parsing with expiry/Max-Age
- **Status Mapping**: TS/TF/TP code parsing

Run tests:

```bash
npm test -- tests/services/airtel-session-proxy.test.ts
```

---

## Error Handling

### DIRECT Mode

| Error            | Handling                                   |
| ---------------- | ------------------------------------------ |
| 401 Unauthorized | Clear token, force re-authentication       |
| 5xx Server Error | Exponential backoff retry (max 3 attempts) |
| ECONNABORTED     | Exponential backoff retry                  |
| Other            | Return error in response                   |

### WEB Mode

| Error                   | Handling                                  |
| ----------------------- | ----------------------------------------- |
| 401/403 Session Expired | Clear session, force re-login             |
| Login Failure (non-2xx) | Throw error, will retry on next operation |
| 5xx Server Error        | Exponential backoff retry                 |
| Cookie Load Error       | Continue with fresh login                 |

### PROXY Mode

| Error                | Handling                     |
| -------------------- | ---------------------------- |
| Proxy Unavailable    | Return error in response     |
| Invalid Proxy Secret | Proxy returns 401/403        |
| Other HTTP Errors    | Return error status and data |

---

## Security Considerations

### Session Storage

- **Default**: In-memory only (cleared on service restart)
- **Optional**: File-based with `AIRTEL_SESSION_STORE_PATH`
  - Use restricted permissions (0600)
  - Keep in private storage directory
  - Consider disk encryption for sensitive environments

### Credentials

- **Never hardcode** credentials in code
- Use `AIRTEL_USERNAME` / `AIRTEL_PASSWORD` environment variables
- Rotate credentials regularly
- Use service accounts with minimal permissions

### CSRF Protection

- Automatically extracted from responses
- Sent in all session-based requests
- Validated by server

### Proxy Secret

- Sent in `X-Airtel-Proxy-Secret` header to proxy service
- Use strong, randomly generated secrets
- Rotate periodically
- Keep separate from API keys

---

## Monitoring & Observability

All operations include timing metrics:

```typescript
{
  success: boolean,
  data?: unknown,
  error?: unknown,
  providerResponseTimeMs: number  // ← Always included
}
```

Log format (structured JSON):

```json
{
  "timestamp": "2025-06-09T10:18:14.000Z",
  "level": "info",
  "message": "Airtel: Sending payout",
  "phoneNumber": "2348012345678",
  "amount": "5000",
  "mode": "web",
  "duration": 1234,
  "success": true,
  "requestId": "req-12345"
}
```

---

## Migration Guide

### From Direct to Web Mode

1. **Enable web mode**:

   ```env
   AIRTEL_MODE=web
   AIRTEL_WEB_BASE_URL=https://web.airtel.example
   AIRTEL_USERNAME=...
   AIRTEL_PASSWORD=...
   ```

2. **Service auto-detects mode** - No code changes needed

3. **First request triggers login** - Session established and cached

4. **Monitor credentials** - Ensure they're managed securely

### From Direct to Proxy Mode

1. **Deploy proxy service** with session management

2. **Configure proxy endpoint**:

   ```env
   AIRTEL_PROXY_URL=https://proxy.example.com
   AIRTEL_PROXY_SECRET=...
   ```

3. **Keep Direct API credentials** (proxy may route to Direct if needed)

4. **Test failover behavior** with proxy unavailability

---

## Troubleshooting

### Session Not Persisting

**Symptom**: Service re-logs in on every restart

**Solution**:

- Set `AIRTEL_SESSION_STORE_PATH` to a valid, writable directory
- Verify file permissions (755 for directory, 644 for file)
- Check logs for "Failed to persist Airtel session"

### CSRF Token Validation Fails

**Symptom**: Login succeeds but operations return 403/CSRF errors

**Solution**:

- Verify `AIRTEL_CSRF_FIELD` matches form field name
- Check HTML response for CSRF token format
- Enable debug logging to see extracted token

### Session Expires Too Quickly

**Symptom**: Sessions refreshed/expired after few minutes

**Solution**:

- Increase `AIRTEL_SESSION_TTL_MS` (default: 20 minutes)
- Check server-side session timeout setting
- Monitor actual cookie expiry in Set-Cookie headers

### Proxy Secret Not Recognized

**Symptom**: Proxy returns 401 or "Invalid Secret"

**Solution**:

- Verify `AIRTEL_PROXY_SECRET` value matches proxy config
- Check header name matches (`X-Airtel-Proxy-Secret`)
- Rotate secret and re-deploy proxy

---

## Performance Notes

- **DIRECT Mode**: ~100-200ms per request (API roundtrip)
- **WEB Mode**: ~500-1000ms on login, ~200-300ms on cached session
- **PROXY Mode**: ~300-500ms (depends on proxy latency)

Session caching in WEB mode significantly reduces latency for consecutive operations.

---

## Support Matrix

| Scenario               | Direct        | Web             | Proxy         |
| ---------------------- | ------------- | --------------- | ------------- |
| REST API available     | ✅            | ❌              | ✅            |
| Web portal required    | ❌            | ✅              | ✅            |
| Cookie auth            | ❌            | ✅              | ✅            |
| OAuth2 token auth      | ✅            | ❌              | ✅            |
| Requires proxy service | ❌            | ❌              | ✅            |
| Session persistence    | Token cache   | File-based      | N/A           |
| Automatic refresh      | Token renewal | Session refresh | Proxy handles |

---

## Related Documentation

- [Orange Money Provider](./docs/ORANGE_INTEGRATION.md) - Similar multi-mode implementation
- [Mobile Money Architecture](./docs/ARCHITECTURE.md) - Provider pattern design
- [PACT Contract Tests](./tests/pact/airtel.pact.test.ts) - API contract validation
