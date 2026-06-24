# API Versioning Guide

## Overview

This document describes the API versioning strategy for the Mobile Money application. Versioning allows the API to evolve and introduce breaking changes without affecting existing clients.

## Current API Versions

- **v1** - Current stable version
  - Transactions (deposit, withdraw, get, update notes, search)
  - Bulk operations
  - Transaction disputes
  - Statistics

- **v2** - Future version (in development)
  - All v1 features
  - Webhooks support
  - Advanced filtering
  - New authentication schemes

## Route Structure

### V1 Endpoints (Current)

```
POST   /api/v1/transactions/deposit
POST   /api/v1/transactions/withdraw
GET    /api/v1/transactions/:id
PATCH  /api/v1/transactions/:id/notes
GET    /api/v1/transactions/search

POST   /api/v1/transactions/bulk
GET    /api/v1/transactions/bulk/:batchId

POST   /api/v1/transactions/:id/dispute
GET    /api/v1/transactions/:id/disputes
GET    /api/v1/disputes
GET    /api/v1/disputes/:id
PATCH  /api/v1/disputes/:id

GET    /api/v1/stats
GET    /api/v1/stats/summary
GET    /api/v1/stats/daily
```

### Legacy Endpoints (Backward Compatible)

```
GET    /api/transactions -> redirects to /api/v1/transactions
POST   /api/transactions -> redirects to /api/v1/transactions
...
```

## How to Use Versioning

### Method 1: URL Path Versioning (Recommended)

Include version in the URL path:

```bash
# Using v1
curl -X POST https://api.example.com/api/v1/transactions/deposit \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "phone": "+1234567890"}'

# Using v2 (future)
curl -X POST https://api.example.com/api/v2/transactions/deposit \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "phone": "+1234567890"}'
```

### Method 2: Accept-Version Header Versioning

Specify version in the `Accept-Version` header:

```bash
curl -X POST https://api.example.com/api/transactions/deposit \
  -H "Accept-Version: v1" \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "phone": "+1234567890"}'
```

The legacy `Accept: application/json;version=v1` format is still accepted for
backward compatibility, but `Accept-Version` is the preferred header.

### Method 3: Legacy Endpoints

For backward compatibility, old endpoints still work:

```bash
curl -X POST https://api.example.com/api/transactions/deposit \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "phone": "+1234567890"}'

# Response includes: API-Version: v1
# Response includes: Deprecation: true
# Response includes: Sunset: <future date>
```

## Response Headers

All API responses include version information:

```
HTTP/1.1 200 OK
API-Version: v1
Vary: Accept, Accept-Version
Deprecation: false
Content-Type: application/json

{
  "data": {...}
}
```

### Header Meanings

- **API-Version**: Current API version used for this request
- **Vary**: Cache control - indicates version headers affect response
- **Deprecation**: True if endpoint is deprecated
- **Sunset**: Date when deprecated endpoint will be removed
- **Link**: Alternative version URL (on Deprecation: true)

## Supported Versions

Always check the `/api/version` endpoint for current support status:

```bash
curl https://api.example.com/api/version

{
  "current": "v1",
  "supported": ["v1"],
  "deprecated": [],
  "upcoming": ["v2"]
}
```

## Migration Guide: v1 to v2

### Breaking Changes in v2

- Request/response structure changes
- New required fields
- Removed deprecated endpoints
- Authentication changes

### Migration Steps

1. **Update endpoint URLs** from `/api/` to `/api/v2/`
2. **Update request payloads** to match v2 schema
3. **Update response parsers** to handle new v2 format
4. **Test thoroughly** against v2 endpoints
5. **Migrate in production** before v1 sunset date

### Timeline

- **v1 Stable**: Current
- **v2 Beta**: Next release
- **v1 Deprecation**: 180 days after v2 GA
- **v1 Sunset**: 210 days after v2 GA

## Error Handling

### Unsupported Version

```json
HTTP/1.1 400 Bad Request

{
  "error": "Unsupported API Version",
  "message": "API version v99 is not supported. Supported versions: v1",
  "supportedVersions": ["v1"]
}
```

### Version Extraction Priority

1. URL path (highest priority)
   - `/api/v1/transactions` → uses `v1`

2. Accept-Version header
   - `Accept-Version: v1` → uses `v1`

3. Accept header
   - `Accept: application/json;version=v1` → uses `v1`

4. Default
   - No version specified → uses `v1`

## Best Practices

### For API Clients

1. **Always specify a version** explicitly
2. **Pin to a specific version** in production
3. **Monitor Deprecation headers** for upcoming changes
4. **Plan migrations** before sunset dates
5. **Test against beta versions** early

### For API Development

1. **Never break v1** unless at sunset date
2. **Prepare v2 early** with beta period
3. **Document breaking changes** clearly
4. **Maintain backward compatibility** when possible
5. **Communicate deprecations** in advance

## Testing

### Run Version Tests

```bash
npm test tests/api-versioning.test.ts
```

### Manual Testing

```bash
# Test v1
curl -i https://api.example.com/api/v1/transactions

# Test Accept-Version header
curl -i -H "Accept-Version: v1" \
  https://api.example.com/api/transactions

# Test legacy endpoint
curl -i https://api.example.com/api/transactions

# All should work and return:
# API-Version: v1
```

## Monitoring

### Metrics to Track

- Requests per version
- Deprecated endpoint usage
- Version mismatch errors
- Migration progress to v2

### Example Monitoring Query

```sql
SELECT 
  api_version,
  COUNT(*) as requests,
  DATE(timestamp) as date
FROM api_requests
GROUP BY api_version, DATE(timestamp)
ORDER BY date DESC;
```

## Deprecation Policy

### Announcement Phase
- Announce deprecation 180 days before sunset
- Add `Deprecation: true` header
- Add `Sunset` header with removal date
- Add `Link` header with migration URL

### Migration Phase
- Keep all endpoints functional
- Provide migration tools/docs
- Adjust rate limits if needed
- Support technical questions

### Sunset Phase
- Remove deprecated endpoints
- Redirect to newer versions (if possible)
- Log migration metrics
- Publish migration summary

## FAQ

**Q: Should I use URL versioning or Accept-Version header?**
A: Use URL path versioning. It's clearer, easier to debug, and better for caching.

**Q: How do I know which version to use?**
A: Use the latest stable version. Check `/api/version` for current recommendations.

**Q: What happens if I don't specify a version?**
A: The API defaults to v1, but you should always specify explicitly.

**Q: Can I use multiple versions in the same application?**
A: Yes, but keep them separate. Don't mix v1 and v2 in the same request chain.

**Q: When will v1 be deprecated?**
A: v1 will be supported until at least v2 goes GA + 180 days. We'll announce dates 6 months in advance.

## Support

For versioning questions or issues:
1. Check this documentation
2. Review test cases in `tests/api-versioning.test.ts`
3. File an issue on GitHub
4. Contact API support

## References

- [Semantic Versioning](https://semver.org/)
- [API Versioning Best Practices](https://swagger.io/blog/api-strategy/good-api-versioning-practices/)
- [HTTP Deprecation Header](https://tools.ietf.org/html/draft-dalal-deprecation-header)
