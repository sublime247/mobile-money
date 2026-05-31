# SSO Integration (Okta/SAML)

## Overview

The Admin SSO Integration allows internal staff to login to the admin portal via corporate SSO providers (Okta, Microsoft Entra, or generic SAML). This implementation provides seamless authentication, automatic role mapping based on IdP groups, and automatic offboarding when users are deactivated in the IdP.

## Features

- ✅ **Passport.js SAML Strategy** - Industry-standard SAML 2.0 authentication
- ✅ **Multiple IdP Support** - Okta, Microsoft Entra (Azure AD), and generic SAML
- ✅ **Automatic Group-to-Role Mapping** - IdP groups automatically map to RBAC roles
- ✅ **SSO-Only Enforcement** - Employees can be required to use SSO
- ✅ **Automatic Offboarding** - Users deactivated in IdP are automatically disabled
- ✅ **Audit Logging** - All SSO events are logged for compliance
- ✅ **Session Management** - Redis-backed SSO session tracking

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   User Browser  │───▶│  Admin Portal    │───▶│  SSO Provider   │
│                 │    │  (Express App)   │    │  (Okta/Entra)   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │                        │
                                ▼                        ▼
                       ┌──────────────────┐    ┌─────────────────┐
                       │   PostgreSQL     │    │  SAML Response  │
                       │   (SSO Users,    │    │  (Groups, etc.) │
                       │    Mappings)     │    └─────────────────┘
                       └──────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │     Redis        │
                       │  (SSO Sessions)  │
                       └──────────────────┘
```

## Database Schema

### Tables

#### `sso_providers`

Stores SSO provider configurations.

```sql
CREATE TABLE sso_providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100) NOT NULL UNIQUE,
  provider_type   VARCHAR(50) NOT NULL CHECK (provider_type IN ('okta', 'entra', 'saml')),
  entry_point     VARCHAR(500) NOT NULL,
  issuer          VARCHAR(500) NOT NULL,
  cert            TEXT NOT NULL,
  callback_url    VARCHAR(500) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### `sso_group_role_mappings`

Maps IdP groups to RBAC roles.

```sql
CREATE TABLE sso_group_role_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  sso_group_name  VARCHAR(255) NOT NULL,
  role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_id, sso_group_name)
);
```

#### `sso_users`

Stores SSO-specific user data.

```sql
CREATE TABLE sso_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id     UUID NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  sso_subject     VARCHAR(500) NOT NULL,
  sso_email       VARCHAR(255),
  sso_groups      TEXT[] DEFAULT '{}',
  last_login_at   TIMESTAMP,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_id, sso_subject)
);
```

#### `sso_audit_log`

Logs all SSO events for compliance and debugging.

```sql
CREATE TABLE sso_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID REFERENCES sso_providers(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type      VARCHAR(50) NOT NULL CHECK (event_type IN (
    'login', 'logout', 'group_sync', 'role_update', 'user_deactivated', 'error'
  )),
  event_data      JSONB DEFAULT '{}',
  ip_address      VARCHAR(45),
  user_agent      TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## Configuration

### Environment Variables

Add the following to your `.env` file:

```bash
# Enable/disable SSO authentication
SSO_ENABLED=true

# Enforce SSO-only for employees
SSO_ENFORCE_EMPLOYEES=true

# Employee email domain for SSO enforcement
SSO_EMPLOYEE_EMAIL_DOMAIN=company.com

# Okta Configuration
SSO_OKTA_ENABLED=true
SSO_OKTA_NAME=Okta
SSO_OKTA_ENTRY_POINT=https://your-org.okta.com/app/your-app/sso/saml
SSO_OKTA_ISSUER=http://www.okta.com/your-issuer-id
SSO_OKTA_CERT=-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----
SSO_OKTA_CALLBACK_URL=http://localhost:3000/api/auth/sso/callback/okta

# Microsoft Entra (Azure AD) Configuration
SSO_ENTRA_ENABLED=true
SSO_ENTRA_NAME=Entra
SSO_ENTRA_ENTRY_POINT=https://login.microsoftonline.com/your-tenant-id/saml2
SSO_ENTRA_ISSUER=https://sts.windows.net/your-tenant-id/
SSO_ENTRA_CERT=-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----
SSO_ENTRA_CALLBACK_URL=http://localhost:3000/api/auth/sso/callback/entra
```

### IdP Configuration

#### Okta Setup

1. **Create a new SAML Application in Okta:**
   - Go to Applications → Create App Integration
   - Select SAML 2.0
   - App name: `Mobile Money Admin Portal`

2. **Configure SAML Settings:**
   - Single sign on URL: `http://localhost:3000/api/auth/sso/callback/okta`
   - Audience URI (SP Entity ID): `http://localhost:3000`
   - Name ID format: EmailAddress
   - Application username: Email

3. **Configure Attribute Statements:**
   - `email` → `user.email`
   - `firstName` → `user.firstName`
   - `lastName` → `user.lastName`

4. **Configure Group Attribute Statements:**
   - `groups` → `.*` (or specific group filters)

5. **Download the IdP Certificate** and add to `SSO_OKTA_CERT`

#### Microsoft Entra (Azure AD) Setup

1. **Enterprise Application:**
   - Go to Azure AD → Enterprise Applications → New Application
   - Create your own application → Name: `Mobile Money Admin Portal`

2. **SAML Configuration:**
   - Entity ID: `http://localhost:3000`
   - Reply URL: `http://localhost:3000/api/auth/sso/callback/entra`
   - Sign on URL: `http://localhost:3000/api/auth/sso/login/entra`

3. **User Attributes & Claims:**
   - `user.userprincipalname` → `email`
   - `user.givenname` → `firstName`
   - `user.surname` → `lastName`

4. **Download the Federation Metadata XML** and extract the certificate for `SSO_ENTRA_CERT`

## API Endpoints

### SSO Authentication

#### `GET /api/auth/sso/providers`

List all active SSO providers.

**Response:**

```json
{
  "providers": [
    {
      "id": "uuid",
      "name": "Okta",
      "provider_type": "okta",
      "login_url": "/api/auth/sso/login/uuid"
    }
  ]
}
```

#### `GET /api/auth/sso/login/:providerId`

Initiate SSO login for a specific provider.

**Response:** Redirects to IdP login page.

#### `POST /api/auth/sso/callback/:providerId`

Handle SAML callback from IdP.

**Response:**

```json
{
  "message": "SSO login successful",
  "token": "jwt-token",
  "refreshToken": "refresh-token",
  "user": {
    "id": "user-uuid",
    "email": "user@company.com",
    "groups": ["Admins", "Developers"]
  }
}
```

### Group-to-Role Mappings (Admin Only)

#### `GET /api/auth/sso/mappings/:providerId`

Get group-to-role mappings for a provider.

**Response:**

```json
{
  "mappings": [
    {
      "sso_group_name": "Admins",
      "role_name": "admin",
      "role_id": "role-uuid"
    }
  ]
}
```

#### `POST /api/auth/sso/mappings/:providerId`

Add group-to-role mapping.

**Request:**

```json
{
  "sso_group_name": "Developers",
  "role_id": "role-uuid"
}
```

**Response:**

```json
{
  "message": "Group-role mapping added successfully",
  "mapping": {
    "sso_group_name": "Developers",
    "role_id": "role-uuid"
  }
}
```

#### `DELETE /api/auth/sso/mappings/:providerId/:groupName`

Remove group-to-role mapping.

**Response:**

```json
{
  "message": "Group-role mapping removed successfully"
}
```

### Audit Log (Admin Only)

#### `GET /api/auth/sso/audit/:userId`

Get SSO audit log for a user.

**Query Parameters:**

- `limit` (optional): Number of records to return (default: 50)

**Response:**

```json
{
  "audit_log": [
    {
      "id": "uuid",
      "provider_name": "Okta",
      "event_type": "login",
      "event_data": {
        "sso_subject": "user@company.com",
        "sso_groups": ["Admins"]
      },
      "ip_address": "192.168.1.1",
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

## Automatic Group-to-Role Mapping

The system automatically maps IdP groups to RBAC roles based on configured mappings.

### Role Priority

When a user belongs to multiple groups, the system assigns the highest priority role:

1. **admin** - Full system access
2. **user** - Standard user access
3. **viewer** - Read-only access

### Example Mapping

```sql
-- Map Okta "Admins" group to admin role
INSERT INTO sso_group_role_mappings (provider_id, sso_group_name, role_id)
SELECT
  (SELECT id FROM sso_providers WHERE name = 'Okta'),
  'Admins',
  (SELECT id FROM roles WHERE name = 'admin');

-- Map Okta "Developers" group to user role
INSERT INTO sso_group_role_mappings (provider_id, sso_group_name, role_id)
SELECT
  (SELECT id FROM sso_providers WHERE name = 'Okta'),
  'Developers',
  (SELECT id FROM roles WHERE name = 'user');
```

## Automatic Offboarding

When a user is deactivated in the IdP, the system can automatically disable their account.

### Manual Offboarding

Use the SSO service to deactivate a user:

```typescript
import { ssoService } from "../auth/sso";

await ssoService.deactivateUser(userId, "User left the company");
```

### Automatic Offboarding via IdP

Configure your IdP to send a SAML Logout Request when a user is deactivated. The system will:

1. Receive the SLO request
2. Mark the SSO user as inactive
3. Log the deactivation event
4. Prevent future logins

## SSO-Only Enforcement

### For Employees

When `SSO_ENFORCE_EMPLOYEES=true` and `SSO_EMPLOYEE_EMAIL_DOMAIN=company.com`:

- Users with `@company.com` email addresses **must** use SSO
- Password-based authentication is blocked for these users
- Login attempts return a 403 error with SSO provider information

### For SSO Users

Users created via SSO are marked as `sso_only=true` in the database:

- Cannot use password-based authentication
- Must always authenticate via their SSO provider
- Account is tied to the IdP

## Middleware

### `enforceSSOOnly`

Checks if user is SSO-only and rejects password-based auth.

### `enforceSSOForEmployees`

Checks if employee email domain requires SSO.

### `checkSSOUserStatus`

Validates SSO user account is active.

### `attachSSOContext`

Attaches SSO user information to request.

### `validateSSOProvider`

Validates SSO provider exists and is active.

## Usage Examples

### Protect Admin Routes with SSO

```typescript
import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import {
  checkSSOUserStatus,
  attachSSOContext,
} from "../middleware/ssoEnforcement";

const router = Router();

router.get(
  "/admin/users",
  authenticateToken,
  checkSSOUserStatus,
  attachSSOContext,
  requireAdmin,
  getUsersHandler,
);
```

### Check SSO Context in Controller

```typescript
async function getUsersHandler(req: Request, res: Response) {
  const isSSOUser = (req as any).isSSOUser;
  const ssoUser = (req as any).ssoUser;

  if (isSSOUser) {
    console.log(
      `SSO User: ${ssoUser.sso_subject}, Groups: ${ssoUser.sso_groups}`,
    );
  }

  // ... rest of handler
}
```

## Security Considerations

1. **Certificate Validation**: Always validate IdP certificates in production
2. **HTTPS Required**: SSO callbacks must use HTTPS in production
3. **Session Timeout**: Configure appropriate session timeouts in Redis
4. **Audit Logging**: All SSO events are logged for compliance
5. **Group Validation**: Validate group memberships before role assignment
6. **Offboarding**: Implement automatic offboarding when users leave the organization

## Troubleshooting

### Common Issues

#### 1. SSO Login Fails with "Invalid SAML Response"

**Causes:**

- Certificate mismatch
- Incorrect issuer/entry point
- Clock skew between systems

**Solution:**

- Verify certificate matches IdP configuration
- Check issuer and entry point URLs
- Ensure system clocks are synchronized

#### 2. User Not Getting Correct Role

**Causes:**

- Group name mismatch
- Missing group-to-role mapping
- User not in expected groups

**Solution:**

- Check `sso_audit_log` for group sync events
- Verify group names match IdP configuration
- Add missing group-to-role mappings

#### 3. SSO-Only User Cannot Login

**Causes:**

- SSO provider inactive
- User account deactivated
- Certificate expired

**Solution:**

- Check `sso_providers` table for active status
- Verify `sso_users.is_active = true`
- Renew IdP certificate

### Debug Mode

Enable debug logging:

```bash
DEBUG=passport-saml:* npm run dev
```

### Audit Log Queries

```sql
-- Recent SSO logins
SELECT * FROM sso_audit_log
WHERE event_type = 'login'
ORDER BY created_at DESC
LIMIT 10;

-- Failed SSO attempts
SELECT * FROM sso_audit_log
WHERE event_type = 'error'
ORDER BY created_at DESC
LIMIT 10;

-- User role changes
SELECT * FROM sso_audit_log
WHERE event_type = 'role_update'
AND user_id = 'user-uuid'
ORDER BY created_at DESC;
```

## Migration Guide

### From Password Auth to SSO

1. **Run the migration:**

   ```bash
   psql -d your_database -f database/migrations/009_add_sso_support.sql
   ```

2. **Configure SSO providers** in `.env`

3. **Initialize providers:**

   ```typescript
   import { initializeSSOProviders } from "../config/sso";
   await initializeSSOProviders();
   ```

4. **Add group-to-role mappings** via API or database

5. **Test SSO login** with a test user

6. **Rollout to users** gradually

## Performance Considerations

1. **Caching**: SSO provider configurations are cached in memory
2. **Database Indexes**: Proper indexes on SSO tables for fast lookups
3. **Redis Sessions**: SSO sessions stored in Redis for fast validation
4. **Connection Pooling**: Uses existing database connection pool

## Compliance

- **Audit Trail**: All SSO events logged with timestamps
- **User Tracking**: Track which users accessed the system via SSO
- **Group Changes**: Log when user groups/roles change
- **Offboarding**: Automatic deactivation when users leave

## Support

For issues or questions:

1. Check the audit log: `GET /api/auth/sso/audit/:userId`
2. Review SSO configuration: `GET /api/auth/sso/providers`
3. Verify group mappings: `GET /api/auth/sso/mappings/:providerId`
4. Check application logs for `[SSO]` prefixed messages
