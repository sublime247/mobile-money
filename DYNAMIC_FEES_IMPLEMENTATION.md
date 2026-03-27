# Dynamic Fee Adjustment API Implementation

## Overview

This implementation enables admins to dynamically adjust global transaction fees via API instead of environment variables. Fees are stored in the database with Redis caching for performance, and all changes are audited.

## Features

✅ **Database Storage**: Fee configurations stored in `fee_configurations` table  
✅ **CRUD Endpoints**: Full REST API for managing fee configurations  
✅ **Redis Caching**: Active configuration cached for performance  
✅ **Instant Updates**: Cache invalidation ensures immediate effect  
✅ **Audit Trail**: Complete audit history in `fee_configuration_audit` table  
✅ **Backward Compatibility**: Fallback to environment variables  
✅ **RBAC Integration**: Admin-only access with proper permissions  

## API Endpoints

### Public Endpoints

- `POST /api/fees/calculate` - Calculate fee for given amount
- `GET /api/fees/configurations/active` - Get active fee configuration

### Admin Endpoints (require `admin:system` permission)

- `GET /api/fees/configurations` - List all fee configurations
- `GET /api/fees/configurations/:id` - Get specific configuration
- `POST /api/fees/configurations` - Create new configuration
- `PUT /api/fees/configurations/:id` - Update configuration
- `DELETE /api/fees/configurations/:id` - Delete configuration (if not active)
- `POST /api/fees/configurations/:id/activate` - Activate configuration
- `GET /api/fees/configurations/:id/audit` - Get audit history

## Database Schema

### fee_configurations
```sql
CREATE TABLE fee_configurations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(100) UNIQUE NOT NULL,
  description      TEXT,
  fee_percentage   DECIMAL(5,4) NOT NULL CHECK (fee_percentage >= 0 AND fee_percentage <= 100),
  fee_minimum      DECIMAL(20,7) NOT NULL CHECK (fee_minimum >= 0),
  fee_maximum      DECIMAL(20,7) NOT NULL CHECK (fee_maximum >= fee_minimum),
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_by       UUID NOT NULL REFERENCES users(id),
  updated_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### fee_configuration_audit
```sql
CREATE TABLE fee_configuration_audit (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_config_id    UUID NOT NULL REFERENCES fee_configurations(id) ON DELETE CASCADE,
  action           VARCHAR(20) NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'ACTIVATE', 'DEACTIVATE')),
  old_values       JSONB,
  new_values       JSONB,
  changed_by       UUID NOT NULL REFERENCES users(id),
  changed_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address       INET,
  user_agent       TEXT
);
```

## Usage Examples

### Calculate Fee
```bash
curl -X POST http://localhost:3000/api/fees/calculate \
  -H "Content-Type: application/json" \
  -d '{"amount": 10000}'
```

### Create Fee Configuration (Admin)
```bash
curl -X POST http://localhost:3000/api/fees/configurations \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "premium",
    "description": "Premium tier fees",
    "feePercentage": 2.0,
    "feeMinimum": 100,
    "feeMaximum": 10000
  }'
```

### Activate Configuration (Admin)
```bash
curl -X POST http://localhost:3000/api/fees/configurations/<id>/activate \
  -H "Authorization: Bearer <admin-jwt>"
```

## Migration

Run the migration to set up the database schema:

```bash
# Apply migration 008_add_fee_configurations.sql
psql -d mobile_money -f migrations/008_add_fee_configurations.sql
```

The migration automatically creates a default fee configuration using current environment variable values.

## Caching Strategy

- **Active Configuration**: Cached for 1 hour with key `fee_config:active`
- **Individual Configs**: Cached for 1 hour with key `fee_config:{id}`
- **Cache Invalidation**: Automatic on updates/activations
- **Fallback**: Environment variables if cache/database fails

## Audit Logging

All fee configuration changes are logged with:
- Action type (CREATE, UPDATE, DELETE, ACTIVATE)
- Old and new values (JSON)
- User who made the change
- Timestamp, IP address, and user agent
- Complete audit trail accessible via API

## Backward Compatibility

The system maintains backward compatibility:
- Existing `calculateFee()` function updated to async
- New `calculateFeeSync()` for synchronous fallback
- Environment variables still work as fallback
- Gradual migration path for existing code

## Security

- Admin-only access via RBAC middleware
- Input validation with Zod schemas
- SQL injection protection via parameterized queries
- Audit logging for compliance
- Cannot delete active configurations

## Performance

- Redis caching reduces database load
- Efficient cache invalidation strategy
- Minimal impact on transaction processing
- Fallback ensures system availability

## Files Modified/Created

### New Files
- `src/services/feeService.ts` - Core fee management service
- `src/routes/fees.ts` - REST API endpoints
- `migrations/008_add_fee_configurations.sql` - Database schema
- `tests/routes/fees.test.ts` - API tests

### Modified Files
- `src/utils/fees.ts` - Updated for async operation
- `src/routes/reports.ts` - Updated fee calculations
- `src/index.ts` - Added fees routes
- `tests/utils/fees.test.ts` - Updated tests

## Testing

Run tests to verify implementation:

```bash
npm test -- fees
```

The implementation includes comprehensive tests for both the service layer and API endpoints.