# GraphQL Depth Limiter

## Overview

The GraphQL depth limiter protects the API from deeply nested query attacks that could cause performance degradation or denial of service.

## Implementation

**Location**: `src/graphql/server.ts`

The depth limiter is configured in the Apollo Server validation rules:

```typescript
validationRules: [
  depthLimit(5),
  createComplexityRule({
    maximumComplexity: 1000,
    estimators: [
      fieldExtensionsEstimator(),
      simpleEstimator({ defaultComplexity: 1 }),
    ],
  }),
],
```

## Configuration

- **Maximum Depth**: 5 levels
- **Package**: `graphql-depth-limit@1.1.0`

## How It Works

The depth limiter analyzes incoming GraphQL queries and counts the nesting level. Queries exceeding the configured depth are rejected before execution.

### Example: Allowed Query (Depth 4)

```graphql
query {
  transaction(id: "1") {
    id
    dispute {
      id
      notes {
        id
        note
      }
    }
  }
}
```

### Example: Rejected Query (Depth 6)

```graphql
query {
  me {
    friends {
      friends {
        friends {
          friends {
            friends {
              id
            }
          }
        }
      }
    }
  }
}
```

**Error Response**: `"exceeds maximum operation depth of 5"`

## Testing

Comprehensive tests are located in `src/tests/graphql-depth-complexity.test.ts`:

- ✅ Queries within depth limit (pass)
- ✅ Queries exceeding depth limit (rejected)
- ✅ Boundary testing (depth 5 vs depth 6)
- ✅ Combined with complexity rules

## Security Benefits

1. **DoS Prevention**: Prevents attackers from crafting deeply nested queries that consume excessive server resources
2. **Performance Protection**: Limits resolver execution depth
3. **Resource Management**: Prevents database query explosion from nested resolvers

## Related

- Query Complexity Limiting (max 1000 complexity points)
- Automatic Persisted Queries (APQ)
- GraphQL validation rules

## References

- [graphql-depth-limit](https://github.com/stems/graphql-depth-limit)
- Issue #880
