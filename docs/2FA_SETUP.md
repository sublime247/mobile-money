# Two-Factor Authentication (2FA) Setup Guide

This guide explains how to set up and use Two-Factor Authentication (2FA) in the Mobile Money application using TOTP (Time-based One-Time Password).

## Overview

2FA adds an extra layer of security by requiring users to provide two forms of authentication:

1. Something they know (password/phone number)
2. Something they have (authenticator app code or backup code)

## Features

- **TOTP Support**: Compatible with Google Authenticator, Authy, Microsoft Authenticator, etc.
- **QR Code Setup**: Easy setup by scanning QR codes
- **Backup Codes**: 10 single-use backup codes for account recovery
- **Flexible Integration**: Can be required for sensitive operations
- **Secure Storage**: Secrets are hashed and encrypted in the database

## API Endpoints

### 1. Setup 2FA

**Endpoint**: `POST /api/auth/2fa/setup`

**Description**: Generate TOTP secret and QR code for 2FA setup

**Headers**:

- `Authorization: Bearer <jwt_token>`

**Response**:

```json
{
  "message": "2FA setup initiated",
  "secret": "JBSWY3DPEHPK3PXP",
  "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "backupCodes": [
    "AB12CD34",
    "EF56GH78",
    "IJ90KL12",
    "MN34OP56",
    "QR78ST90",
    "UV12WX34",
    "YZ56AB78",
    "CD90EF12",
    "GH34IJ56",
    "KL78MN90"
  ],
  "instructions": {
    "step1": "Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.)",
    "step2": "Enter the 6-digit code from your app to verify setup",
    "step3": "Save the backup codes in a secure location"
  }
}
```

### 2. Verify and Enable 2FA

**Endpoint**: `POST /api/auth/2fa/verify`

**Description**: Verify TOTP token and enable 2FA for user

**Headers**:

- `Authorization: Bearer <jwt_token>`

**Body**:

```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "token": "123456"
}
```

**Response**:

```json
{
  "message": "2FA enabled successfully",
  "twoFactorEnabled": true,
  "instructions": {
    "nextStep": "Use your authenticator app to generate codes for future logins",
    "backupCodesNote": "Keep your backup codes safe - they can be used if you lose access to your authenticator app"
  }
}
```

### 3. Authenticate with 2FA

**Endpoint**: `POST /api/auth/2fa/authenticate`

**Description**: Verify TOTP token for 2FA-protected operations

**Headers**:

- `Authorization: Bearer <jwt_token>`

**Body**:

```json
{
  "token": "123456"
}
```

**Response**:

```json
{
  "message": "2FA authentication successful",
  "verified": true
}
```

### 4. Use Backup Code

**Endpoint**: `POST /api/auth/2fa/backup-code`

**Description**: Authenticate using backup code

**Headers**:

- `Authorization: Bearer <jwt_token>`

**Body**:

```json
{
  "backupCode": "AB12CD34"
}
```

**Response**:

```json
{
  "message": "Backup code authentication successful",
  "verified": true,
  "warning": "This backup code has been used and is no longer valid. Consider regenerating backup codes if you have used multiple codes."
}
```

### 5. Disable 2FA

**Endpoint**: `DELETE /api/auth/2fa/disable`

**Description**: Disable 2FA for user

**Headers**:

- `Authorization: Bearer <jwt_token>`

**Body**:

```json
{
  "token": "123456"
}
```

**Response**:

```json
{
  "message": "2FA disabled successfully",
  "twoFactorEnabled": false
}
```

## Setup Process

### Step 1: Generate 2FA Secret

1. Authenticate with your JWT token
2. Call `POST /api/auth/2fa/setup`
3. Save the secret and backup codes securely
4. Scan the QR code with your authenticator app

### Step 2: Verify Setup

1. Enter the 6-digit code from your authenticator app
2. Call `POST /api/auth/2fa/verify` with the secret and token
3. 2FA will be enabled for your account

### Step 3: Using 2FA

For sensitive operations, provide either:

- **TOTP Token**: In `X-2FA-Token` header
- **Backup Code**: In request body as `backupCode` or `backup_code`

## Integration Examples

### Using TOTP Token

```javascript
const headers = {
  Authorization: "Bearer <jwt_token>",
  "X-2FA-Token": "123456", // Code from authenticator app
};

fetch("/api/sensitive-operation", { headers });
```

### Using Backup Code

```javascript
const body = {
  // ... other data
  backupCode: "AB12CD34", // One of your backup codes
};

fetch("/api/sensitive-operation", {
  method: "POST",
  headers: {
    Authorization: "Bearer <jwt_token>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
```

## Security Considerations

### Backup Codes

- Store backup codes in a secure, offline location
- Each backup code can only be used once
- Consider regenerating backup codes if you use more than 2-3 codes

### TOTP Secret

- The secret is stored encrypted in the database
- Never share your secret with anyone
- If you suspect your secret is compromised, disable and re-enable 2FA

### Recovery Options

- Keep backup codes accessible but secure
- If you lose all backup codes and access to your authenticator app, you may need account recovery support

## Recommended Authenticator Apps

- **Google Authenticator** (iOS, Android)
- **Authy** (iOS, Android, Desktop)
- **Microsoft Authenticator** (iOS, Android)
- **1Password** (iOS, Android, Desktop, Browser)
- **LastPass Authenticator** (iOS, Android)

## Troubleshooting

### Time Sync Issues

If your authenticator app codes aren't working:

1. Check your device's time is set to automatic
2. Ensure time zone is correct
3. Try resyncing in your authenticator app

### Lost Access

If you lose access to your authenticator app:

1. Use one of your backup codes
2. Immediately disable and re-enable 2FA to generate new backup codes
3. Contact support if you've lost all backup codes

### Invalid Codes

- Codes expire every 30 seconds
- Wait for a new code if the current one shows as invalid
- Ensure you're using the correct account in your authenticator app

## Database Schema

The following tables are added to support 2FA:

### users table additions

```sql
ALTER TABLE users
ADD COLUMN two_factor_secret VARCHAR(32),
ADD COLUMN two_factor_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN two_factor_verified BOOLEAN DEFAULT FALSE,
ADD COLUMN email VARCHAR(255);
```

### backup_codes table

```sql
CREATE TABLE backup_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash VARCHAR(255) NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  used_at TIMESTAMP
);
```

## Middleware Integration

Use the provided middleware to protect sensitive operations:

```typescript
import { requireTwoFactor } from "../middleware/twoFactor";

// Require 2FA for sensitive operations
router.post("/transfer", authenticateToken, requireTwoFactor, transferHandler);

// Optional 2FA (allows operation if 2FA not enabled)
router.post(
  "/profile-update",
  authenticateToken,
  optionalTwoFactor,
  updateProfile,
);
```

## Testing

The implementation includes comprehensive error handling and validation:

- Invalid TOTP tokens
- Used backup codes
- Missing authentication
- User not found
- 2FA not enabled

All endpoints return appropriate HTTP status codes and error messages for debugging.
