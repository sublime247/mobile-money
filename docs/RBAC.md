# Role-Based Access Control (RBAC) Documentation

## Overview

This document describes the Role-Based Access Control (RBAC) system implemented in the mobile-money backend service. The RBAC system provides fine-grained access control to API endpoints based on user roles and permissions.

## Roles

The system defines three primary roles:

### 1. Admin

- **Description**: Full access to all system resources
- **Permissions**: All available permissions
- **Use Case**: System administrators, superusers
- **Access Level**: Complete system control

### 2. User

- **Description**: Read/write access to own data
- **Permissions**: `read:own`, `write:own`, `delete:own`
- **Use Case**: Regular mobile money users
- **Access Level**: Personal data management

### 3. Viewer

- **Description**: Read-only access to public data
- **Permissions**: `read:all`
- **Use Case**: Auditors, read-only stakeholders
- **Access Level**: View-only access

## Permissions

Permissions define specific actions that users can perform:

### Data Access Permissions

| Permission   | Description                   | Typical Roles |
| ------------ | ----------------------------- | ------------- |
| `read:own`   | Read user's own data          | user, admin   |
| `write:own`  | Create/update user's own data | user, admin   |
| `delete:own` | Delete user's own data        | user, admin   |
| `read:all`   | Read all system data          | viewer, admin |
| `write:all`  | Write/update all system data  | admin         |
| `delete:all` | Delete any system data        | admin         |

### System Permissions

| Permission     | Description                | Typical Roles |
| -------------- | -------------------------- | ------------- |
| `admin:system` | Full system administration | admin         |

## Database Schema

### Tables

#### `roles`

```sql
CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### `permissions`

```sql
CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### `role_permissions` (Junction Table)

```sql
CREATE TABLE role_permissions (
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_id)
);
```

#### `users` (Updated)

```sql
-- Added role_id foreign key
ALTER TABLE users
ADD COLUMN role_id UUID REFERENCES roles(id);
```

## Implementation

### JWT Token Structure

JWT tokens now include role information:

```json
{
  "userId": "uuid",
  "email": "user@example.com",
  "role": "user|admin|viewer",
  "iat": 1234567890,
  "exp": 1234571490
}
```

### Middleware Usage

#### 1. Permission-based Access Control

```typescript
import { requirePermission } from "../middleware/rbac";

// Require specific permission
router.get("/transactions", requirePermission("read:own"), getTransactions);
router.post("/transactions", requirePermission("write:own"), createTransaction);
```

#### 2. Role-based Access Control

```typescript
import { requireRole } from "../middleware/rbac";

// Require specific role
router.get("/admin/users", requireRole("admin"), getAllUsers);
```

#### 3. Multiple Permission Check

```typescript
import { requireAnyPermission } from "../middleware/rbac";

// Require any of the specified permissions
router.get("/data", requireAnyPermission(["read:own", "read:all"]), getData);
```

#### 4. User Context Attachment

```typescript
import { attachUserContext } from "../middleware/rbac";

// Attach role and permissions without blocking
router.get("/profile", authenticateToken, attachUserContext, getProfile);
```

### Helper Middleware

The system provides several pre-configured middleware functions:

- `requireAdmin`: Requires admin role
- `requireReadAccess`: Requires `read:own` or `read:all` permission
- `requireWriteAccess`: Requires `write:own` or `write:all` permission
- `requireOwnDataAccess(action)`: Requires `${action}:own` permission

## API Examples

### Authentication

#### Login

```bash
POST /api/auth/login
Content-Type: application/json

{
  "phone_number": "+237123456789"
}
```

Response:

```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "userId": "uuid",
    "phone_number": "+237123456789",
    "kyc_level": "unverified",
    "role": "user"
  }
}
```

#### Get User Info

```bash
GET /api/auth/me
Authorization: Bearer <token>
```

Response:

```json
{
  "user": {
    "userId": "uuid",
    "phone_number": "+237123456789",
    "kyc_level": "unverified",
    "role": "user",
    "permissions": ["read:own", "write:own", "delete:own"]
  },
  "tokenInfo": {
    "issuedAt": 1234567890,
    "expiresAt": 1234571490
  }
}
```

### Protected Endpoints

#### Admin-only Endpoint

```bash
GET /api/admin/users
Authorization: Bearer <admin-token>
```

#### User Data Access

```bash
GET /api/transactions
Authorization: Bearer <user-token>
```

## Error Responses

### 401 Unauthorized

```json
{
  "error": "Unauthorized",
  "message": "Authentication required"
}
```

### 403 Forbidden

```json
{
  "error": "Forbidden",
  "message": "Insufficient permissions. Required: read:all",
  "userRole": "user",
  "userPermissions": ["read:own", "write:own", "delete:own"]
}
```

## Security Considerations

1. **Token Validation**: Always validate JWT tokens before checking permissions
2. **Permission Caching**: Consider caching user permissions for performance
3. **Role Changes**: Role changes take effect on next login (token refresh)
4. **Database Security**: Ensure proper database permissions for RBAC tables
5. **Audit Logging**: Log permission checks for security auditing

## Migration

To set up RBAC in your database:

1. Run the main schema:

   ```bash
   psql -d your_database -f database/schema.sql
   ```

2. Run the seed migration:
   ```bash
   psql -d your_database -f database/migrations/001_seed_rbac.sql
   ```

This will create the necessary tables and populate them with default roles and permissions.

## Testing

The RBAC system can be tested using different user roles:

1. **Admin User**: Full access to all endpoints
2. **Regular User**: Access to own data only
3. **Viewer User**: Read-only access to public data

Use the login endpoint to generate tokens for different roles and test access controls accordingly.

## Future Enhancements

1. **Dynamic Permissions**: Runtime permission management
2. **Resource-based Access Control**: More granular resource permissions
3. **Permission Inheritance**: Role hierarchy support
4. **Time-based Access**: Temporary permissions
5. **IP-based Restrictions**: Location-based access control
