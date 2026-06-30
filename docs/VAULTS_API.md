# Vaults API Documentation

The Vaults API allows users to compartmentalize their balance into named savings goals or vaults (e.g., "Taxes", "Vacation", "Emergency Fund"). This feature enables users to organize their funds while maintaining accurate ledger tracking.

## Overview

- **Base URL**: `/api/v1/vaults`
- **Authentication**: JWT token required for all endpoints
- **Content-Type**: `application/json`

## Key Features

- Create and manage named vaults
- Transfer funds between main balance and vaults
- Track vault transaction history
- Maintain ledger accuracy (total balance = main balance + vault balances)
- Atomic fund transfers with distributed locking
- Vault balance validation and constraints

## Endpoints

### 1. Create Vault

**POST** `/api/v1/vaults`

Creates a new vault for the authenticated user.

**Request Body:**

```json
{
  "name": "Emergency Fund",
  "description": "Savings for unexpected expenses",
  "targetAmount": "50000.00"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "vault-uuid",
    "userId": "user-uuid",
    "name": "Emergency Fund",
    "description": "Savings for unexpected expenses",
    "balance": "0",
    "targetAmount": "50000.00",
    "isActive": true,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

**Validation Rules:**

- `name`: Required, 1-100 characters, must be unique per user
- `description`: Optional, max 1000 characters
- `targetAmount`: Optional, valid decimal format

### 2. Get User Vaults

**GET** `/api/v1/vaults`

Retrieves all vaults for the authenticated user.

**Query Parameters:**

- `includeInactive` (boolean): Include inactive vaults (default: false)

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "vault-uuid-1",
      "userId": "user-uuid",
      "name": "Emergency Fund",
      "description": "Savings for unexpected expenses",
      "balance": "15000.50",
      "targetAmount": "50000.00",
      "isActive": true,
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-20T14:22:00Z"
    },
    {
      "id": "vault-uuid-2",
      "userId": "user-uuid",
      "name": "Vacation",
      "description": "Summer trip to Europe",
      "balance": "8500.00",
      "targetAmount": "25000.00",
      "isActive": true,
      "createdAt": "2024-01-16T09:15:00Z",
      "updatedAt": "2024-01-21T11:45:00Z"
    }
  ]
}
```

### 3. Get Balance Summary

**GET** `/api/v1/vaults/balance-summary`

Retrieves a comprehensive balance summary showing main balance, vault balances, and total balance.

**Response:**

```json
{
  "success": true,
  "data": {
    "mainBalance": "75000.00",
    "vaultBalances": [
      {
        "vaultId": "vault-uuid-1",
        "vaultName": "Emergency Fund",
        "balance": "15000.50"
      },
      {
        "vaultId": "vault-uuid-2",
        "vaultName": "Vacation",
        "balance": "8500.00"
      }
    ],
    "totalBalance": "98500.50"
  }
}
```

### 4. Get Vault Details

**GET** `/api/v1/vaults/:vaultId`

Retrieves details for a specific vault.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "vault-uuid",
    "userId": "user-uuid",
    "name": "Emergency Fund",
    "description": "Savings for unexpected expenses",
    "balance": "15000.50",
    "targetAmount": "50000.00",
    "isActive": true,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-20T14:22:00Z"
  }
}
```

### 5. Update Vault

**PUT** `/api/v1/vaults/:vaultId`

Updates vault properties (name, description, target amount, active status).

**Request Body:**

```json
{
  "name": "Emergency Fund - Updated",
  "description": "Updated description",
  "targetAmount": "60000.00",
  "isActive": true
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "vault-uuid",
    "userId": "user-uuid",
    "name": "Emergency Fund - Updated",
    "description": "Updated description",
    "balance": "15000.50",
    "targetAmount": "60000.00",
    "isActive": true,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-22T16:30:00Z"
  }
}
```

### 6. Delete Vault

**DELETE** `/api/v1/vaults/:vaultId`

Deletes a vault. Only allowed if vault balance is zero.

**Response:**

```json
{
  "success": true,
  "message": "Vault deleted successfully"
}
```

**Error Response (Non-zero balance):**

```json
{
  "error": "Cannot delete vault",
  "message": "Vault may have a non-zero balance"
}
```

### 7. Transfer Funds

**POST** `/api/v1/vaults/:vaultId/transfer`

Transfers funds between main balance and vault.

**Request Body:**

```json
{
  "type": "deposit",
  "amount": "1000.00",
  "description": "Monthly savings"
}
```

**Parameters:**

- `type`: "deposit" (main → vault) or "withdraw" (vault → main)
- `amount`: Positive decimal amount
- `description`: Optional transfer description

**Response:**

```json
{
  "success": true,
  "data": {
    "vault": {
      "id": "vault-uuid",
      "userId": "user-uuid",
      "name": "Emergency Fund",
      "balance": "16000.50",
      "targetAmount": "50000.00",
      "isActive": true,
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-22T17:00:00Z"
    },
    "transaction": {
      "id": "vault-tx-uuid",
      "vaultId": "vault-uuid",
      "userId": "user-uuid",
      "type": "deposit",
      "amount": "1000.00",
      "description": "Monthly savings",
      "createdAt": "2024-01-22T17:00:00Z"
    }
  }
}
```

**Error Responses:**

```json
// Insufficient main balance for deposit
{
  "error": "Insufficient funds",
  "message": "Insufficient main balance"
}

// Insufficient vault balance for withdrawal
{
  "error": "Insufficient funds",
  "message": "Insufficient vault balance"
}
```

### 8. Get Vault Transaction History

**GET** `/api/v1/vaults/:vaultId/transactions`

Retrieves transaction history for a specific vault.

**Query Parameters:**

- `limit` (number): Max results per page (default: 50, max: 100)
- `offset` (number): Pagination offset (default: 0)

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "vault-tx-uuid-1",
      "vaultId": "vault-uuid",
      "userId": "user-uuid",
      "type": "deposit",
      "amount": "1000.00",
      "description": "Monthly savings",
      "createdAt": "2024-01-22T17:00:00Z"
    },
    {
      "id": "vault-tx-uuid-2",
      "vaultId": "vault-uuid",
      "userId": "user-uuid",
      "type": "withdraw",
      "amount": "500.00",
      "description": "Emergency expense",
      "createdAt": "2024-01-20T14:22:00Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}
```

## Error Handling

All endpoints return consistent error responses:

```json
{
  "error": "Error Type",
  "message": "Detailed error message",
  "details": "Additional validation details (for validation errors)"
}
```

**Common HTTP Status Codes:**

- `200`: Success
- `201`: Created (for vault creation)
- `400`: Bad Request (validation errors, insufficient funds)
- `401`: Unauthorized (missing/invalid JWT token)
- `403`: Forbidden (accessing another user's vault)
- `404`: Not Found (vault doesn't exist)
- `409`: Conflict (duplicate vault name)
- `500`: Internal Server Error

## Security & Concurrency

- **Authentication**: All endpoints require valid JWT token
- **Authorization**: Users can only access their own vaults
- **Distributed Locking**: Fund transfers use Redis-based locks to prevent race conditions
- **Atomic Transactions**: Database transactions ensure data consistency
- **Balance Validation**: Prevents negative balances and overdrafts

## Ledger Accuracy

The vault system maintains ledger accuracy through:

1. **Atomic Transfers**: All fund movements are atomic database transactions
2. **Balance Tracking**: Vault balances are stored and updated consistently
3. **Transaction Records**: All transfers create audit trail records
4. **Main Balance Adjustment**: Corresponding entries in main transactions table
5. **Validation**: Balance checks prevent invalid operations

**Formula**: `Total User Balance = Main Balance + Sum(Active Vault Balances)`

## Usage Examples

### Creating a Savings Goal

```bash
curl -X POST /api/v1/vaults \
  -H "Authorization: Bearer <jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "House Down Payment",
    "description": "Saving for first home",
    "targetAmount": "100000.00"
  }'
```

### Monthly Savings Deposit

```bash
curl -X POST /api/v1/vaults/vault-uuid/transfer \
  -H "Authorization: Bearer <jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "deposit",
    "amount": "2000.00",
    "description": "Monthly savings goal"
  }'
```

### Checking Progress

```bash
curl -X GET /api/v1/vaults/balance-summary \
  -H "Authorization: Bearer <jwt-token>"
```

This vault system provides a robust foundation for users to organize their finances while maintaining the integrity of the underlying ledger system.
