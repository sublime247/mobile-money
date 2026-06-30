# Advanced Redis Caching with Selective Invalidation

This implementation uses a cache-aside pattern with Redis tag-based invalidation for expensive database queries like transaction history and statistics.

## Overview

The caching system reduces database load by caching expensive queries and invalidating them intelligently when related data changes. It implements:

1. **Cache-aside pattern**: Queries are cached after first fetch, subsequent requests hit cache
2. **Tag-based invalidation**: Related caches can be invalidated together using tags
3. **TTL policies**: Different query types have different cache lifetimes
4. **Selective invalidation**: Only affected caches are invalidated on transaction changes

## Architecture

### Components

#### 1. **CachedQueryManager** (`src/services/cachedQueryManager.ts`)

- Main cache management service
- Handles cache storage, retrieval, and invalidation
- TTL policy definitions per query type
- Tag management for selective invalidation

#### 2. **CacheAside** (`src/services/cacheAside.ts`)

- Cache-aside pattern implementation
- Helper functions and middleware
- Transaction cache invalidation hooks

#### 3. **CachedTransactionService** (`src/services/cachedTransactionService.ts`)

- Caching layer for transaction queries
- Wraps `transactionModel.list()` and related methods
- Automatic cache invalidation on transaction changes

#### 4. **CachedStatsService** (`src/services/cachedStatsService.ts`)

- Caching layer for statistics queries
- Wraps expensive stats calculations
- Supports multiple time-based aggregations

## TTL Policies

Different query types have different cache lifetimes:

```typescript
QUERY_TTL_POLICIES = {
  TRANSACTION_HISTORY: 300, // 5 minutes - updated frequently
  USER_STATS: 600, // 10 minutes - user-specific stats
  GENERAL_STATS: 900, // 15 minutes - global stats
  VOLUME_BY_PROVIDER: 600, // 10 minutes
  ACTIVE_USERS_COUNT: 900, // 15 minutes
  PRICE_HISTORY: 3600, // 1 hour - least frequently updated
  USER_STATUS_HISTORY: 600, // 10 minutes
};
```

## Cache Tags

Tags are used for selective invalidation:

```typescript
CacheTags.userHistory(userId); // Invalidate user's transaction history
CacheTags.userStats(userId); // Invalidate user's statistics
CacheTags.generalStats(); // Invalidate global statistics
CacheTags.userTransaction(userId); // Invalidate all user transaction-related caches
CacheTags.provider(provider); // Invalidate provider-specific caches
```

## Usage Examples

### Basic Query Caching

```typescript
import { getCachedUserTransactionHistory } from "@/services/cachedTransactionService";

// Automatically cached with 5-minute TTL
const transactions = await getCachedUserTransactionHistory("user-123", {
  offset: 0,
  limit: 50,
  startDate: new Date("2024-01-01"),
});
```

### Stats Caching

```typescript
import {
  getCachedGeneralStats,
  getCachedVolumeByProvider,
} from "@/services/cachedStatsService";

// Cached for 15 minutes
const stats = await getCachedGeneralStats();

// Provider stats also cached
const byProvider = await getCachedVolumeByProvider(
  new Date("2024-01-01"),
  new Date("2024-01-31"),
);
```

### Manual Invalidation

```typescript
import { TransactionCacheInvalidation } from "@/services/cacheAside";

// Invalidate all caches for a user on transaction update
await TransactionCacheInvalidation.invalidateUserCaches("user-123");

// Invalidate provider stats on new transaction
await TransactionCacheInvalidation.invalidateProviderStats("MTN");

// Invalidate all caches (nuclear option)
await TransactionCacheInvalidation.invalidateAll();
```

## Automatic Invalidation

When a transaction is created or updated:

1. **On Create**:
   - User's transaction cache invalidated
   - Provider stats invalidated
   - General stats invalidated
   - Auto-triggered before DB insert

2. **On Status Update**:
   - User's caches invalidated
   - General stats invalidated
   - Auto-triggered after status change

3. **On Metadata Update**:
   - User's transaction cache invalidated
   - General stats invalidated

This ensures data freshness while maintaining performance.

## Performance Metrics

Expected performance improvements:

### Database Load Reduction

- **History queries**: 70-80% reduction (first cache miss pays cost, subsequent requests cache hits)
- **Stats queries**: 80-90% reduction (expensive aggregations, long TTLs)
- **Overall DB load**: 60-70% reduction across typical workloads

### Response Time

- **Cache hit**: <10ms average (vs 200-500ms for DB query)
- **Cache miss**: Same as DB query (backward compatible)

### Memory Usage

- L2 Redis cache: ~100KB per 1000 cached queries
- Automatic TTL-based cleanup prevents memory leaks

## Monitoring

### Cache Statistics

```typescript
const stats = await cachedQueryManager.getStats();
console.log(stats);
// {
//   totalKeys: 150,
//   totalTags: 45,
//   memoryUsed: "2.5M"
// }
```

### Cache Headers

All cached responses include an `X-Cache` header:

- `X-Cache: HIT` - Response served from cache
- `X-Cache: MISS` - Response fetched from database

### Logging

All cache operations are logged:

- `[cache] Cache hit` - Cache hit logged at debug level
- `[cache] Cache invalidated by tag` - Invalidation logged at info level
- `[cache] Cache set with tags` - Set operations logged at debug level

## Configuration

### Adjusting TTLs

Update `QUERY_TTL_POLICIES` in `src/services/cachedQueryManager.ts`:

```typescript
QUERY_TTL_POLICIES = {
  TRANSACTION_HISTORY: 600, // Increase to 10 minutes if DB load is non-issue
  USER_STATS: 900, // Increase if stats freshness isn't critical
  // ...
};
```

### Custom Tags

Add new tags for custom invalidation patterns:

```typescript
// In CacheTags class
static customQuery(id: string): string {
  return `custom:${id}`;
}
```

## Testing

Run cache tests:

```bash
npm test -- src/routes/__tests__/caching.test.ts
```

Tests cover:

- Cache-aside pattern
- Tag-based invalidation
- TTL policies
- Performance improvements
- Cache key generation

## Best Practices

1. **Cache Read-Heavy Queries**: History and stats are ideal
2. **Short TTLs for Fresh Data**: User stats use 10min TTL for freshness
3. **Selective Invalidation**: Only invalidate affected caches
4. **Graceful Degradation**: Cache misses fall back to DB queries
5. **Monitor Cache Hit Rates**: Aim for 70%+ hit rate in production
6. **Clean Up Old Entries**: Redis TTLs prevent memory bloat

## Troubleshooting

### Cache not invalidating

- Check Redis connectivity
- Verify tag names are correct
- Check logs for invalidation errors

### High memory usage

- Reduce TTL values for less critical queries
- Check for pattern-based invalidation leaks
- Monitor with `cachedQueryManager.getStats()`

### Low cache hit rate

- Increase TTL values for appropriate queries
- Check if invalidation is too aggressive
- Verify caching is actually being used

## Future Improvements

1. **Cache warming**: Pre-populate cache on app start
2. **Adaptive TTLs**: Adjust TTLs based on hit rates
3. **Cache stats dashboard**: Real-time cache metrics UI
4. **Distributed cache invalidation**: Sync across multiple instances
5. **Cache compression**: Reduce memory for large result sets
