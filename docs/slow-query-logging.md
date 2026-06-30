# Slow Query Logging

This document describes the slow query logging feature implemented to help identify database performance issues.

## Overview

The slow query logging feature automatically tracks database query execution times and logs queries that exceed a configurable threshold. This helps developers identify performance bottlenecks and optimize database operations.

## Configuration

### Environment Variables

Add these variables to your `.env` file:

```bash
# Threshold in milliseconds for logging slow database queries (default: 1000)
SLOW_QUERY_THRESHOLD_MS=1000

# Enable slow query logging in development (default: true)
ENABLE_SLOW_QUERY_LOGGING=true
```

### Behavior

- **Development Environment**: Slow query logging is enabled by default unless explicitly disabled
- **Production Environment**: Logging is only enabled if `ENABLE_SLOW_QUERY_LOGGING=true`
- **Default Threshold**: 1000ms (1 second)

## Log Format

Slow queries are logged in structured JSON format:

```json
{
  "type": "slow_query",
  "duration": 1500,
  "threshold": 1000,
  "query": "SELECT * FROM transactions WHERE user_id = ***",
  "params": ["***@***.***", "***"],
  "timestamp": "2024-03-25T18:34:00.000Z"
}
```

## Data Sanitization

To protect sensitive information, the logging system automatically sanitizes:

### Query Text Sanitization

- Email addresses: `user@example.com` → `***@***.***`
- Phone numbers: `1234567890` → `***`
- API keys/tokens: `abc123def456...` → `***`
- Large numbers (>1,000,000): `1234567` → `***`
- String values in WHERE clauses: `WHERE email = 'user@example.com'` → `WHERE email = ***`
- String values in INSERT/UPDATE: `VALUES('secret')` → `VALUES(***)`

### Parameter Sanitization

- Email patterns in parameters
- Phone number patterns (10+ digits)
- Long alphanumeric strings (20+ chars)
- Large numeric values
- Long string values (>50 chars)

## Implementation Details

### Database Pool Enhancement

The feature extends the standard PostgreSQL pool with query timing:

```typescript
class SlowQueryPool extends Pool {
  async query<T = any>(
    queryConfig: QueryConfig | string,
    values?: any[],
  ): Promise<QueryResult<T>> {
    const startTime = process.hrtime.bigint();
    // ... execute query with timing
    const durationMs = Number(endTime - startTime) / 1e6;

    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logSlowQuery(queryString, durationMs, queryParams);
    }

    return result;
  }
}
```

### High-Resolution Timing

Uses `process.hrtime.bigint()` for nanosecond precision timing, converted to milliseconds for logging.

## Usage Examples

### Basic Usage

```typescript
import { pool } from "./src/config/database";

// Any query using the pool will be automatically tracked
const result = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
```

### Monitoring Logs

In development, you'll see slow queries in your console output:

```bash
{"type":"slow_query","duration":1250,"threshold":1000,"query":"SELECT * FROM transactions WHERE user_id = ***","params":["***"],"timestamp":"2024-03-25T18:34:00.000Z"}
```

## Performance Impact

- **Minimal Overhead**: High-resolution timing has negligible performance cost
- **Conditional Logging**: Only slow queries trigger the logging logic
- **Efficient Sanitization**: Regex patterns optimized for common sensitive data patterns
- **Async Operations**: Logging doesn't block query execution

## Troubleshooting

### No Logs Appearing

1. Check if `ENABLE_SLOW_QUERY_LOGGING=true` in your environment
2. Verify queries are actually exceeding the threshold
3. Ensure you're using the enhanced `pool` from `src/config/database`

### Too Many Logs

1. Increase `SLOW_QUERY_THRESHOLD_MS` to reduce noise
2. Set `ENABLE_SLOW_QUERY_LOGGING=false` to disable temporarily
3. Review query performance and add appropriate indexes

### Sensitive Data in Logs

If you notice sensitive data in logs:

1. Report the specific pattern that wasn't caught
2. Extend the sanitization functions with additional regex patterns
3. Consider adding custom sanitization for your specific data patterns

## Best Practices

1. **Start Conservative**: Begin with a higher threshold (2000ms) and adjust down
2. **Monitor Regularly**: Check logs during development and testing
3. **Optimize Queries**: Use logged queries to identify optimization opportunities
4. **Index Strategy**: Add database indexes for frequently slow queries
5. **Query Review**: Periodically review and optimize slow query patterns

## Integration with Monitoring

The structured JSON format integrates well with log aggregation tools:

- **ELK Stack**: Can parse and index slow query logs
- **Datadog**: Supports structured JSON logging
- **Splunk**: Can ingest and analyze slow query patterns
- **CloudWatch**: JSON logs can be filtered and analyzed

## Security Considerations

- All sensitive data is automatically sanitized
- No raw query parameters are logged
- Email addresses, phone numbers, and API keys are masked
- Large numeric values are obfuscated
- The sanitization can be extended for additional sensitive patterns
