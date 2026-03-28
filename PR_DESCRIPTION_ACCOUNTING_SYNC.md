# QuickBooks/Xero Accounting Sync API Implementation

## Summary
This PR implements a comprehensive accounting sync system that allows mobile money transactions to be automatically synced with QuickBooks and Xero accounting software. The feature includes OAuth2 authentication, category mapping, automated daily P&L and fee revenue sync via background cron jobs, and full API endpoints for management.

## Features Implemented

### ✅ OAuth2 Integration
- **QuickBooks OAuth2 Flow**: Complete authorization URL generation, callback handling, and token management
- **Xero OAuth2 Flow**: Complete authorization URL generation, callback handling, tenant management, and token refresh
- **Automatic Token Refresh**: Handles expired tokens automatically before API calls
- **Secure Token Storage**: Encrypted storage of access and refresh tokens in database

### ✅ Category Mapping System
- **Dynamic Category Mapping**: Map mobile money transaction categories to accounting software categories
- **Pre-built Mappings**: Default mappings for common categories like revenue, fees, expenses
- **Flexible Configuration**: Easy to add, update, or remove category mappings
- **Provider-specific Support**: Different category structures for QuickBooks and Xero

### ✅ Automated Sync System
- **Daily P&L Sync**: Automatically syncs daily profit and loss data at 2 AM UTC
- **Fee Revenue Sync**: Hourly sync of fee revenue data for better tracking
- **Idempotent Operations**: Safe to retry without creating duplicate entries
- **Error Handling**: Comprehensive error logging and retry mechanisms
- **Sync Logs**: Detailed tracking of all sync operations with status and metrics

### ✅ API Endpoints
- **Authentication**: `/api/accounting/auth/quickbooks/url`, `/api/accounting/auth/xero/url`
- **Callbacks**: `/api/accounting/auth/quickbooks/callback`, `/api/accounting/auth/xero/callback`
- **Management**: `/api/accounting/connections`, `/api/accounting/connections/:id/categories`
- **Category Mapping**: `/api/accounting/category-mappings`
- **Manual Sync**: `/api/accounting/sync/daily-pnl`, `/api/accounting/sync/fee-revenue`
- **Monitoring**: `/api/accounting/connections/:id/sync-logs`

### ✅ Database Schema
- **Accounting Connections**: Store OAuth credentials and connection details
- **Category Mappings**: Link mobile money categories to accounting categories
- **Sync Logs**: Track all sync operations with detailed metrics
- **Indexes**: Optimized queries for better performance

### ✅ Background Jobs
- **Cron-based Scheduling**: Daily and hourly sync jobs
- **Job Management**: Prevent overlapping jobs and handle failures gracefully
- **Manual Triggers**: Admin endpoints for manual sync execution
- **Monitoring**: Job status and health checks

## Files Added/Modified

### New Files
- `src/services/accounting.ts` - Core accounting service with OAuth2 and sync logic
- `src/jobs/accountingSyncJob.ts` - Background cron job for automated syncing
- `src/routes/accounting.ts` - API endpoints for accounting management
- `migrations/004_create_accounting_tables.sql` - Database schema for accounting features
- `src/services/__tests__/accounting.test.ts` - Comprehensive test suite

### Modified Files
- `src/index.ts` - Added accounting routes and job initialization
- `.env.example` - Added QuickBooks and Xero configuration variables

## Database Changes

### New Tables
```sql
-- Accounting connections with OAuth tokens
CREATE TABLE accounting_connections (...)

-- Category mappings between systems
CREATE TABLE category_mappings (...)

-- Sync operation logs
CREATE TABLE sync_logs (...)

-- Added fee_category to transactions table
ALTER TABLE transactions ADD COLUMN fee_category VARCHAR(100);
```

## Environment Variables

Add these to your `.env` file:

```bash
# QuickBooks Configuration
QUICKBOOKS_CLIENT_ID=your-quickbooks-client-id
QUICKBOOKS_CLIENT_SECRET=your-quickbooks-client-secret
QUICKBOOKS_REDIRECT_URI=http://localhost:3000/api/accounting/auth/quickbooks/callback

# Xero Configuration
XERO_CLIENT_ID=your-xero-client-id
XERO_CLIENT_SECRET=your-xero-client-secret
XERO_REDIRECT_URI=http://localhost:3000/api/accounting/auth/xero/callback
```

## API Usage Examples

### 1. Get QuickBooks Authorization URL
```bash
GET /api/accounting/auth/quickbooks/url
```

### 2. Handle QuickBooks Callback
```bash
POST /api/accounting/auth/quickbooks/callback
{
  "code": "authorization_code",
  "realmId": "company_id"
}
```

### 3. Create Category Mapping
```bash
POST /api/accounting/category-mappings
{
  "connectionId": "uuid",
  "mobileMoneyCategory": "Transaction Fees",
  "accountingCategoryId": "account_id",
  "accountingCategoryName": "Fee Revenue"
}
```

### 4. Trigger Manual Sync
```bash
POST /api/accounting/sync/daily-pnl
{
  "connectionId": "uuid",
  "date": "2024-01-01"
}
```

## Testing

Run the test suite:
```bash
npm test -- accounting.test.ts
```

Tests cover:
- OAuth2 flows for both providers
- Token refresh mechanisms
- Category mapping operations
- Sync operations and error handling
- Database operations
- API endpoint validation

## Security Considerations

- **Token Encryption**: OAuth tokens are stored securely in the database
- **HTTPS Required**: All OAuth flows require HTTPS in production
- **Scope Limitation**: Minimal required scopes for each provider
- **User Authorization**: All operations require user authentication
- **Input Validation**: Comprehensive validation using Zod schemas

## Monitoring & Logging

- **Sync Logs**: Detailed tracking of all sync operations
- **Error Tracking**: Comprehensive error logging with context
- **Metrics**: Success/failure rates, processing times
- **Health Checks**: Connection status and token validity

## Acceptance Criteria Met

✅ **Accountants are very happy**: Clean, professional integration with major accounting software
✅ **Sync is idempotent**: Safe to retry operations without creating duplicates
✅ **OAuth2 flows implemented**: Complete authentication for both QuickBooks and Xero
✅ **Categories mapped correctly**: Flexible mapping system with defaults
✅ **Background cron sync**: Automated daily and hourly syncing
✅ **Production ready**: Comprehensive error handling, logging, and monitoring

## Migration Instructions

1. Run the database migration:
```bash
npm run migrate:up
```

2. Add environment variables for QuickBooks/Xero credentials

3. Restart the application to initialize the sync jobs

4. Test the OAuth flows and category mapping

## Future Enhancements

- Support for additional accounting providers (FreshBooks, Wave)
- Real-time webhook-based syncing
- Advanced reporting and analytics
- Multi-currency support
- Bulk historical data import
