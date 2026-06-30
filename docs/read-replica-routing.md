# Read Replica Routing Implementation

## Overview

This document describes the read replica routing system implemented to handle heavy GraphQL queries and admin reports efficiently by automatically routing read-only (SELECT) queries to Postgres read replicas while keeping write operations (INSERT/UPDATE/DELETE) on the primary database.

The system uses two complementary routing strategies:

1. **SQL Query Type Detection** - Analyzes SQL to determine if it's read-only
2. **HTTP Method-Based Routing** - Routes based on REST API HTTP methods (GET to replicas, POST/PUT/PATCH/DELETE to primary)

## Architecture

### HTTP Method-Based Routing Middleware

A new middleware `src/middleware/readReplicaRouting.ts` provides automatic database pool selection based on HTTP method:

- **GET/HEAD/OPTIONS requests** → Replica pool (read-only)
- **POST/PUT/PATCH/DELETE requests** → Primary pool (critical writes)

The middleware attaches routing context to Express Request objects:

```typescript
interface DatabaseRoutingContext {
  useReplicaPool: boolean; // true for GET, false for write operations
  method: string; // HTTP method
  path: string; // Request path
}
```

Usage in services:

```typescript
// Route handlers receive request with routing context
const result = await queryWithContext(req, "SELECT * FROM users", []);
// Automatically routes to replica if GET, primary if POST/write
```

### Smart Query Detection

A new utility `src/utils/readOnlyDetector.ts` provides:

- `isReadOnlyQuery(query)` - Detects if a SQL query is read-only (SELECT)
- `getQueryCommand(query)` - Extracts the main SQL command for logging

### Smart Router Function

New `querySmart()` function in `src/config/database.ts`:

```typescript
export async function querySmart<T>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>>;
```

- Auto-detects read-only queries
- Routes SELECT queries to `queryRead()` (replica pool)
- Routes write operations to `queryWrite()` (primary pool)

### Context-Aware Query Functions

New functions for HTTP request-aware routing:

- `queryWithContext(req, text, params)` - Routes based on HTTP method + SQL query type
- `queryBatchWithContext(req, queries)` - Executes multiple queries with proper routing

### Explicit Routing

Existing functions in `src/config/database.ts`:

- `queryRead()` - Routes to replica pool with fallback to primary
- `queryWrite()` - Routes to primary pool only
- `checkReplicaHealth()` - Health check endpoint for monitoring replicas
- `getPoolStats()` - Get combined statistics on primary and replica pools

## Database Configuration

Replicas are configured via environment variables:

- `DATABASE_URL` - Primary read/write connection
- `READ_REPLICA_URL` - Comma-separated list of replica connection strings

Example:

```
DATABASE_URL=postgresql://user:pass@primary:5432/mobile_money
READ_REPLICA_URL=postgresql://user:pass@replica1:5432/mobile_money,postgresql://user:pass@replica2:5432/mobile_money
```

### HTTP Method-Based Routing Configuration

The `readReplicaRoutingMiddleware` is automatically applied in `src/index.ts` after the request ID middleware.

Enable debug logging for routing decisions:

```
DEBUG_DB_ROUTING=true  # Logs "GET /api/users → REPLICA" style messages
```

Route behavior:

- **GET/HEAD/OPTIONS** → `useReplicaPool = true` (replica preferred)
- **POST/PUT/PATCH/DELETE** → `useReplicaPool = false` (primary only)

Services can check the routing context:

```typescript
// In route handler or service
if (req.dbRouting?.useReplicaPool) {
  // This is a read operation - can use queryRead()
} else {
  // This is a write operation - must use queryWrite()
}
```

## Implementation Details

### Load Balancing

- Round-robin load balancing across multiple replicas
- Automatic failover to primary if replica is unreachable
- No breaking changes to existing code

### Dual Routing Strategy

The system uses complementary routing approaches:

1. **HTTP Method-Based** (middleware level)
   - Fast path for REST APIs
   - Automatically routes GET to replicas
   - HTTP method → routing decision mapping

2. **SQL Query Type** (database level)
   - Fallback detection for complex queries
   - Analyzes SELECT vs INSERT/UPDATE/DELETE
   - Works with services calling queryRead/queryWrite/querySmart directly

Example routing flow:

```
REST API GET request
  ↓
readReplicaRoutingMiddleware (attaches dbRouting context)
  ↓
Route handler calls queryWithContext(req, ...)
  ↓
queryWithContext checks req.dbRouting.useReplicaPool
  ↓
Routes to replica pool with fallback to primary
```

### Models Updated

All model classes now use explicit routing:

- **SELECT queries** → `queryRead()` for optimal performance on replicas
- **INSERT/UPDATE/DELETE** → `queryWrite()` for consistency guarantees

Updated models:

- `src/models/transaction.ts` - 40+ query methods
- `src/models/dispute.ts` - 25+ query methods
- `src/models/users.ts` - 4 query methods
- `src/models/vault.ts` - 15+ query methods
- `src/models/referral.ts` - 4 query methods
- `src/models/contact.ts` - 5 query methods
- `src/models/refreshTokenFamily.ts` - 4 query methods

### Routes Updated

- `src/routes/reports.ts` - Reconciliation reports now use `queryRead()` for heavy aggregations

## Performance Benefits

1. **Replica Utilization**: Heavy reads (reports, analytics) don't contend with writes
2. **Write Consistency**: All writes go to primary, ensuring no stale data issues
3. **Scalability**: Can add multiple replicas for horizontal scaling
4. **Transparent**: No changes needed in service/controller layers
5. **Failsafe**: Automatic fallback to primary if replicas are down

## Monitoring

### Health Check Endpoint

```
GET /admin/health/replicas (requires admin auth)
```

Returns status of all configured replica pools:

```json
[
  { "url": "postgresql://replica1:5432/...", "healthy": true },
  { "url": "postgresql://replica2:5432/...", "healthy": false }
]
```

### Logging

- Failed replica queries log warnings and fall back to primary
- Slow query logging continues to work for all queries

## Migration Path

### For REST API Routes

When implementing route handlers that need database queries:

```typescript
// Use queryWithContext for automatic HTTP method-based routing
import { queryWithContext } from "../config/database";

router.get("/users/:id", async (req: Request, res: Response) => {
  // Automatically routes to replica because HTTP method is GET
  const result = await queryWithContext(
    req,
    "SELECT * FROM users WHERE id = $1",
    [req.params.id],
  );
  res.json(result.rows);
});

router.post("/users", async (req: Request, res: Response) => {
  // Automatically routes to primary because HTTP method is POST
  const result = await queryWithContext(req, "INSERT INTO users ...");
  res.json(result.rows);
});
```

### For Services Using Direct Calls

For services calling query functions without HTTP context:

1. **Option A**: Replace with `querySmart()` for automatic SQL-based routing
2. **Option B**: Replace with `queryRead()` for SELECT or `queryWrite()` for write operations
3. **Option C**: Keep using `pool.query()` (works but doesn't utilize replicas)

### For Backend Workers/Jobs

Background jobs and workers should use explicit routing:

```typescript
import { queryRead, queryWrite } from "../config/database";

// Read-heavy job
await queryRead("SELECT * FROM large_table");

// Write job
await queryWrite("UPDATE jobs SET status = $1 WHERE id = $2", ["done", jobId]);
```

## Future Enhancements

1. **Smart Query Detection in Services**: Extend `readOnlyDetector` to service layer
2. **GraphQL Middleware**: Detect graphql queries as read-only or write
3. **Replica Weights**: Support weighted load balancing based on replica capacity
4. **Metrics Collection**: Prometheus metrics for replica query distribution
5. **Circuit Breaker**: Advanced replica failure handling
6. **Read Consistency Levels**: Support eventual consistency settings for read operations

## Testing

### Manual Testing

```bash
# Verify replica is being used
SELECT * FROM transactions LIMIT 1;  # Should use replica

# Verify writes go to primary
INSERT INTO ... # Should use primary

# Check replica health
curl http://localhost:3000/admin/health/replicas
```

### Load Testing

Use tools like pgbench to verify:

- Read queries distribute across replicas
- Write queries all go to primary
- Failover works when replicas are down
- No performance degradation

## Troubleshooting

### Replicas Not Being Used

1. Verify `READ_REPLICA_URL` environment variable is set
2. Check replica connectivity: `psql postgresql://replica:5432/db -c "SELECT 1"`
3. Review logs for replica connection errors

### Stale Data on Replicas

1. Check replica lag: `SELECT EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp()))`
2. Replicas should be streaming replication (WAL shipping)
3. Consider using read consistency settings if lag is critical

### Performance Issues

1. Compare replica query times vs primary
2. Check replica resources (CPU, disk, network)
3. Consider adding more replicas if load is high
4. Review slow query logs: `src/config/database.ts` SLOW_QUERY_THRESHOLD_MS

## References

- PostgreSQL Streaming Replication: https://www.postgresql.org/docs/current/warm-standby.html
- Read Scaling Patterns: https://wiki.postgresql.org/wiki/Replication,_Clustering,_and_Connection_Pooling
- Implementation Details: `src/config/database.ts`, `src/utils/readOnlyDetector.ts`
