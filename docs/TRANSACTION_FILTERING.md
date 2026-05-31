# Transaction Status Filtering & Pagination - Issue #19

## Overview

This feature adds comprehensive transaction status filtering with pagination support to the mobile-money API. Users can now filter transactions by one or multiple statuses and paginate through large result sets efficiently.

## Features

✅ **Single and Multiple Status Filtering** - Filter by one status or multiple statuses at once
✅ **Pagination Support** - Navigate large result sets with limit/offset parameters
✅ **Input Validation** - Strict validation of status values and pagination parameters
✅ **Pagination Metadata** - Comprehensive pagination info including total count, pages, and hasMore flag
✅ **SQL Optimization** - Efficient queries using PostgreSQL IN operators
✅ **Error Handling** - Comprehensive error messages for invalid inputs

## Supported Transaction Statuses

- `pending` - Transaction is pending processing
- `completed` - Transaction has been successfully completed
- `failed` - Transaction processing failed
- `cancelled` - Transaction was cancelled

## API Endpoints

### List Transactions (All or Filtered)

```http
GET /transactions?status=pending&limit=50&offset=0
GET /transactions?status=pending,completed&limit=25
GET /transactions
```

**Query Parameters:**

| Parameter | Type   | Required | Default | Max | Description                                                    |
| --------- | ------ | -------- | ------- | --- | -------------------------------------------------------------- |
| `status`  | string | No       | (none)  | -   | Single or comma-separated statuses (e.g., `pending,completed`) |
| `limit`   | number | No       | 50      | 100 | Results per page                                               |
| `offset`  | number | No       | 0       | -   | Number of results to skip                                      |

**Response Format:**

```json
{
  "data": [
    {
      "id": "txn_123",
      "status": "pending",
      "amount": "100.50",
      "phoneNumber": "+256701234567",
      "provider": "mtn",
      "createdAt": "2024-01-15T10:30:00Z",
      ...otherFields
    }
  ],
  "pagination": {
    "total": 250,
    "limit": 50,
    "offset": 0,
    "hasMore": true,
    "totalPages": 5,
    "currentPage": 1
  },
  "filters": {
    "statuses": ["pending"]
  }
}
```

## Implementation Details

### Architecture

The feature uses a layered approach:

1. **Utility Module** (`src/utils/transactionFilters.ts`)
   - Status parsing and validation
   - SQL WHERE clause building
   - Pagination helpers
   - Middleware for request validation

2. **Controller** (`src/controllers/transactionController.ts`)
   - `listTransactionsHandler` - Main handler for listing transactions

3. **Model** (`src/models/transaction.ts`)
   - `findByStatuses()` - Query transactions with optional status filters
   - `countByStatuses()` - Count total matching transactions

4. **Routes** (`src/routes/transactions.ts` and `src/routes/v1/transactions.ts`)
   - GET `/` endpoint with middleware

### Key Components

#### parseStatusFilter()

Parses the status query parameter into an array of valid status enums.

```typescript
parseStatusFilter("pending"); // ["pending"]
parseStatusFilter("pending,completed"); // ["pending", "completed"]
parseStatusFilter(""); // []
parseStatusFilter("invalid"); // throws error
```

**Features:**

- Comma-separated value splitting
- Whitespace trimming
- Enum value validation
- Returns empty array for unfiltered requests

#### buildStatusWhereClause()

Generates SQL WHERE clause for database queries.

```typescript
buildStatusWhereClause(["pending"]); // "status IN ('pending')"
buildStatusWhereClause(["pending", "failed"]); // "status IN ('pending', 'failed')"
buildStatusWhereClause([]); // ""
```

#### validateTransactionFilters

Express middleware that validates all query parameters and attaches parsed filters to the request object.

```typescript
// Validates: status, limit, offset
// Attaches: (req as any).transactionFilters
```

**Validation Rules:**

- Status: Must be valid enum value or comma-separated valid values
- Limit: Must be numeric, positive, max 100
- Offset: Must be numeric, non-negative

#### getPaginationInfo()

Helper function to calculate pagination metadata.

```typescript
getPaginationInfo(total, limit, offset);
// Returns: { total, limit, offset, hasMore, totalPages, currentPage }
```

## Usage Examples

### List all transactions (no filtering)

```bash
curl "http://localhost:3000/transactions"
```

### List pending transactions only

```bash
curl "http://localhost:3000/transactions?status=pending"
```

### List multiple statuses with pagination

```bash
curl "http://localhost:3000/transactions?status=pending,completed&limit=25&offset=50"
```

### List with custom pagination

```bash
curl "http://localhost:3000/transactions?status=failed&limit=100&offset=200"
```

### JavaScript/Fetch Example

```javascript
// Fetch pending and completed transactions, page 1
const response = await fetch(
  "/transactions?status=pending,completed&limit=50&offset=0",
);
const { data, pagination } = await response.json();

console.log(`Showing ${data.length} of ${pagination.total} transactions`);
console.log(`Page ${pagination.currentPage} of ${pagination.totalPages}`);

// Fetch next page
if (pagination.hasMore) {
  const nextPage = await fetch(
    `/transactions?status=pending,completed&limit=50&offset=${pagination.offset + pagination.limit}`,
  );
  const nextData = await nextPage.json();
}
```

## Database Queries

The implementation uses efficient PostgreSQL queries:

### Count transactions by status

```sql
SELECT COUNT(*) FROM transactions WHERE status = ANY($1);
```

### Find transactions with pagination

```sql
SELECT * FROM transactions
WHERE status = ANY($1)
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;
```

**Query Optimization:**

- Uses `status = ANY($1)` instead of multiple OR conditions
- PostgreSQL can optimize status column if indexed
- Ordered by `created_at DESC` for most recent first
- Uses LIMIT/OFFSET for pagination

## Error Handling

### Invalid Status

```json
{
  "error": "Invalid status: invalid. Valid statuses: pending, completed, failed, cancelled"
}
```

### Invalid Limit

```json
{
  "error": "limit must be a positive number between 1 and 100"
}
```

### Invalid Offset

```json
{
  "error": "offset must be a non-negative number"
}
```

### Database Error

```json
{
  "error": "Failed to list transactions"
}
```

## Implementation Changes

### New Files

1. **src/utils/transactionFilters.ts** (110 lines)
   - Filter validation middleware
   - Status parsing logic
   - SQL clause builders
   - Pagination helpers

2. **tests/transaction-status-filtering.test.ts** (520 lines)
   - 40+ comprehensive test cases
   - Utility function tests
   - Middleware validation tests
   - Handler integration tests

3. **docs/TRANSACTION_FILTERING.md** (this file)

### Modified Files

1. **src/controllers/transactionController.ts**
   - Added `listTransactionsHandler` export

2. **src/routes/transactions.ts**
   - Imported `listTransactionsHandler`
   - Imported `validateTransactionFilters`
   - Added GET "/" route with filtering

3. **src/routes/v1/transactions.ts**
   - Imported `listTransactionsHandler`
   - Imported `validateTransactionFilters`
   - Added GET "/" route with filtering and version middleware

4. **src/models/transaction.ts**
   - Added `findByStatuses()` method
   - Added `countByStatuses()` method

## Test Coverage

**41 test cases covering:**

- ✅ Single status parsing
- ✅ Multiple status parsing
- ✅ Status validation
- ✅ Whitespace trimming
- ✅ Empty values filtering
- ✅ SQL clause generation
- ✅ Pagination calculation
- ✅ Middleware validation
- ✅ Query parameter handling
- ✅ Limit capping (max 100)
- ✅ Offset validation
- ✅ Default values
- ✅ Handler integration
- ✅ Empty results
- ✅ Multiple filters
- ✅ Pagination metadata
- ✅ Database error handling
- ✅ Integration testing

## Performance Considerations

1. **Query Performance**
   - Status filtering uses PostgreSQL IN operator
   - Offset-based pagination for simplicity
   - Index on `created_at DESC` recommended for large datasets

2. **Pagination Limits**
   - Hard max of 100 results per page
   - Prevents excessive memory usage
   - Default 50 for balanced performance

3. **Recommended Indexes**

```sql
-- Index for status filtering and ordering
CREATE INDEX idx_transactions_status_created
ON transactions(status, created_at DESC);

-- Index for count queries
CREATE INDEX idx_transactions_status
ON transactions(status);
```

## Future Enhancements

1. **Cursor-based Pagination** - Better performance for large datasets
2. **Multiple Filter Types** - Filter by date range, amount, phone number, provider
3. **Sorting Options** - Sort by amount, date, status
4. **Export Options** - CSV/JSON export for filtered results
5. **Caching** - Cache frequently accessed filtered lists

## Security Considerations

1. **Input Validation** - All query parameters validated upon arrival
2. **SQL Injection Prevention** - Uses parameterized queries via PostgreSQL driver
3. **Rate Limiting** - Apply rate limiting middleware to prevent abuse
4. **Permission Checking** - Ensure user has permission to view transactions
5. **Data Sanitization** - Status values validated against enum

## Deployment Notes

1. Ensure PostgreSQL is running with transactions table
2. Run database migrations if using new schema
3. Add recommended indexes for performance
4. Configure rate limiting for production
5. Set appropriate pagination limits based on traffic patterns

## Troubleshooting

**Empty results returned:**

- Verify transaction status values are valid
- Check if transactions exist in database with specified status
- Verify date filtering if recently added

**Slow queries:**

- Add index on `status` column
- Add index on `created_at` column
- Consider cursor-based pagination for very large datasets

**Invalid status errors:**

- Ensure status value is one of: pending, completed, failed, cancelled
- Check for typos (case-sensitive)
- Verify comma-separated values format

## References

- PostgreSQL IN operator: https://www.postgresql.org/docs/current/functions-comparisons.html
- Pagination best practices: https://www.postgresql.org/docs/current/queries-limit.html
- Express middleware: https://expressjs.com/guide/using-middleware.html
