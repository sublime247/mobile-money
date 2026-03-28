# Freeze Account / Blacklist API Implementation

## Overview
This implementation adds the ability for admins to freeze user accounts, preventing all deposits and withdrawals. The feature includes audit logging and instant blocking across all active sessions.

## Changes Made

### 1. Database Migration
**File:** `migrations/009_add_user_status.sql`

- Added `status` column to `users` table with values: `active`, `frozen`, `suspended`
- Created `user_status_audit` table for tracking all status changes
- Added indexes for performance optimization

### 2. User Model Updates
**File:** `src/models/users.ts`

- Added `status` field to `User` interface
- Added `updateStatus()` method with transaction support and audit logging
- Added `getAuditHistory()` method to retrieve status change history

### 3. Account Status Middleware
**File:** `src/middleware/checkAccountStatus.ts`

- Created `FrozenAccountError` custom error class
- Created `checkAccountStatus()` middleware for general account status checking
- Created `checkAccountStatusStrict()` middleware for transaction-related endpoints (fails closed on errors)
- Logs blocked requests with full context for monitoring

### 4. Admin Routes
**File:** `src/routes/admin.ts`

Added three new endpoints:

#### POST `/api/admin/users/:id/freeze`
- Freezes a user account
- Requires admin role
- Requires reason for audit trail
- Returns updated user status

#### POST `/api/admin/users/:id/unfreeze`
- Unfreezes a user account
- Requires admin role
- Requires reason for audit trail
- Returns updated user status

#### GET `/api/admin/users/:id/status-history`
- Retrieves audit history for user status changes
- Requires admin role
- Returns current status and full history

### 5. Transaction Routes Integration
**Files:** 
- `src/routes/transactions.ts`
- `src/routes/v1/transactions.ts`
- `src/routes/bulk.ts`

Added `checkAccountStatusStrict` middleware to:
- Deposit endpoints
- Withdraw endpoints
- Bulk import endpoints

This ensures frozen/suspended users cannot perform any financial transactions.

## API Usage

### Freeze a User Account
```bash
POST /api/admin/users/:id/freeze
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "reason": "Suspicious activity detected"
}
```

**Response:**
```json
{
  "message": "User account frozen successfully",
  "user": {
    "id": "user-uuid",
    "status": "frozen"
  }
}
```

### Unfreeze a User Account
```bash
POST /api/admin/users/:id/unfreeze
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "reason": "Investigation completed, no issues found"
}
```

**Response:**
```json
{
  "message": "User account unfrozen successfully",
  "user": {
    "id": "user-uuid",
    "status": "active"
  }
}
```

### Get Status History
```bash
GET /api/admin/users/:id/status-history
Authorization: Bearer <admin-token>
```

**Response:**
```json
{
  "userId": "user-uuid",
  "currentStatus": "frozen",
  "history": [
    {
      "id": "audit-uuid",
      "action": "FREEZE",
      "oldStatus": "active",
      "newStatus": "frozen",
      "reason": "Suspicious activity detected",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "ipAddress": "192.168.1.1",
      "userAgent": "Mozilla/5.0...",
      "changedByUser": "+1234567890"
    }
  ]
}
```

## Acceptance Criteria

✅ **Frozen users instantly blocked in all active sessions**
- Middleware checks account status on every authenticated request
- Transaction endpoints use strict checking that fails closed on errors
- All deposit/withdrawal attempts are blocked for frozen/suspended users

✅ **Audit logs captured**
- All status changes are logged to `user_status_audit` table
- Includes: action, old status, new status, reason, admin user, IP, user agent, timestamp
- Admin actions are logged to console with full context

## Security Considerations

1. **Authentication Required**: All freeze/unfreeze endpoints require admin authentication
2. **Reason Required**: Admins must provide a reason for audit trail
3. **Self-Protection**: Admins cannot freeze their own accounts (prevents lockout)
4. **Audit Trail**: Complete history of all status changes with full context
5. **Fail-Safe**: Transaction endpoints fail closed on errors (block if status cannot be verified)

## Testing

To test the implementation:

1. Run the migration: `migrations/009_add_user_status.sql`
2. Start the server
3. Use an admin token to freeze a user account
4. Attempt to make a deposit/withdrawal as the frozen user (should be blocked)
5. Check the audit history endpoint
6. Unfreeze the user and verify transactions work again

## Future Enhancements

- Add email/SMS notifications when accounts are frozen/unfrozen
- Add automatic freeze based on fraud detection rules
- Add bulk freeze/unfreeze operations
- Add scheduled unfreeze (temporary freeze)
- Add freeze reason templates for common scenarios
