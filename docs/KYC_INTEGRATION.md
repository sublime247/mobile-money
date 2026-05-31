# KYC Integration Documentation

## Overview

This document describes the KYC (Know Your Customer) integration implemented for the mobile money application using **Entrust Identity Verification** (formerly Onfido).

## Provider Selection

After evaluating multiple KYC providers, we selected **Entrust Identity Verification** for the following reasons:

- **Comprehensive API**: Full-featured REST API with extensive documentation
- **Node.js Support**: Official libraries and SDKs available
- **Global Coverage**: Supports documents from many countries including African nations
- **Flexible Workflows**: Configurable verification workflows
- **Webhook Support**: Real-time status updates via webhooks
- **Sandbox Environment**: Free testing environment for development

## KYC Levels and Transaction Limits

The system implements three KYC levels with corresponding transaction limits:

| KYC Level | Daily Limit (XAF) | Description                                    |
| --------- | ----------------- | ---------------------------------------------- |
| **None**  | 0                 | No verification - can only receive funds       |
| **Basic** | 100,000           | ID document verification required              |
| **Full**  | 10,000,000        | ID + address + biometric verification required |

## Architecture

### Components

1. **KYC Service** (`src/services/kyc.ts`)
   - Core integration with Entrust API
   - Handles applicant creation, document upload, and status checking
   - Manages webhook processing

2. **KYC Controller** (`src/controllers/kycController.ts`)
   - HTTP endpoints for KYC operations
   - Request validation and error handling
   - User authorization checks

3. **KYC Routes** (`src/routes/kycRoutes.ts`)
   - Express route definitions
   - Authentication middleware integration

4. **Database Schema** (`database/schema.sql`)
   - `kyc_applicants` table for storing provider references
   - Integration with existing `users` table

### Database Schema

```sql
CREATE TABLE kyc_applicants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  applicant_id VARCHAR(255) UNIQUE NOT NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'entrust',
  applicant_data JSONB,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  kyc_level VARCHAR(20) NOT NULL DEFAULT 'none',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## API Endpoints

### Applicant Management

#### Create Applicant

```
POST /api/kyc/applicants
Authorization: Bearer <token>
Content-Type: application/json

{
  "first_name": "John",
  "last_name": "Doe",
  "email": "john.doe@example.com",
  "phone_number": "+237123456789",
  "address": {
    "street": "Main Street",
    "town": "Douala",
    "postcode": "12345",
    "country": "CMR"
  }
}
```

#### Get Applicant

```
GET /api/kyc/applicants/{applicantId}
Authorization: Bearer <token>
```

#### Get Verification Status

```
GET /api/kyc/applicants/{applicantId}/status
Authorization: Bearer <token>
```

### Document Upload

#### Upload Document

```
POST /api/kyc/documents
Authorization: Bearer <token>
Content-Type: application/json

{
  "applicant_id": "applicant_123",
  "type": "passport",
  "filename": "passport.jpg",
  "data": "base64_encoded_image_data"
}
```

### Workflow Management

#### Create Workflow Run

```
POST /api/kyc/workflow-runs
Authorization: Bearer <token>
Content-Type: application/json

{
  "applicant_id": "applicant_123",
  "workflow_id": "workflow_456"
}
```

#### Generate SDK Token

```
POST /api/kyc/sdk-token
Authorization: Bearer <token>
Content-Type: application/json

{
  "applicant_id": "applicant_123",
  "application_id": "app_789"
}
```

### User Status

#### Get User KYC Status

```
GET /api/kyc/status
Authorization: Bearer <token>
```

Response:

```json
{
  "success": true,
  "data": {
    "current_kyc_level": "basic",
    "transaction_limits": {
      "dailyLimit": 100000,
      "perTransactionLimit": {
        "min": 100,
        "max": 1000000
      }
    },
    "latest_verification": {
      "applicant_id": "applicant_123",
      "verification_status": "approved",
      "kyc_level": "basic",
      "updated_at": "2024-01-15T10:30:00Z"
    }
  }
}
```

### Webhooks

#### Handle Webhook Events

```
POST /api/kyc/webhooks
X-Onfido-Signature: <signature>
Content-Type: application/json

{
  "payload": {
    "action": "workflow_run.completed",
    "object": {
      "id": "workflow_run_123",
      "type": "workflow_run",
      "status": "completed"
    }
  }
}
```

## Configuration

### Environment Variables

Add the following to your `.env` file:

```bash
# KYC API Configuration
KYC_API_URL=https://api.eu.onfido.com/v3.6
KYC_API_KEY=your_kyc_api_key_here
KYC_DEFAULT_WORKFLOW_ID=your_default_workflow_id_here
KYC_WEBHOOK_SECRET=your_webhook_secret_here

# Transaction Limits (already defined)
LIMIT_UNVERIFIED=0
LIMIT_BASIC=100000
LIMIT_FULL=10000000
```

### Getting API Credentials

1. **Sign up for Entrust Identity Verification**
   - Visit [Entrust Dashboard](https://dashboard.onfido.com/)
   - Create an account

2. **Generate API Token**
   - Go to Developers → API Authentication → Tokens
   - Click "Generate API Token"
   - Choose "Sandbox" for development or "Live" for production
   - Copy the token (starts with `api_sandbox` or `api_live`)

3. **Create Workflow (Optional)**
   - Go to Workflow Studio in the dashboard
   - Create a custom verification workflow
   - Note the workflow ID for use in API calls

4. **Configure Webhooks**
   - Go to Developers → Webhooks
   - Add your webhook endpoint URL
   - Copy the webhook secret for signature verification

## Verification Flow

### Basic KYC Flow

1. **Create Applicant**

   ```http
   POST /api/kyc/applicants
   ```

2. **Upload Document**

   ```http
   POST /api/kyc/documents
   ```

3. **Create Workflow Run**

   ```http
   POST /api/kyc/workflow-runs
   ```

4. **Monitor Status**
   ```http
   GET /api/kyc/applicants/{id}/status
   ```

### Client-Side SDK Integration

For better user experience, use the Entrust Web SDK:

1. **Generate SDK Token**

   ```http
   POST /api/kyc/sdk-token
   ```

2. **Initialize Web SDK**
   ```javascript
   OnfidoSDK.init({
     token: sdk_token,
     onComplete: function (data) {
       // Handle completion
     },
   });
   ```

## Transaction Limit Enforcement

The KYC level automatically affects transaction limits:

```typescript
const limits = kycService.getTransactionLimits(userKycLevel);
// Returns:
// {
//   dailyLimit: 100000,
//   perTransactionLimit: { min: 100, max: 1000000 }
// }
```

## Error Handling

### Common Error Codes

| Status Code | Description      | Resolution                     |
| ----------- | ---------------- | ------------------------------ |
| 400         | Validation Error | Check request format           |
| 401         | Unauthorized     | Provide valid JWT token        |
| 403         | Access Denied    | User doesn't own the applicant |
| 404         | Not Found        | Applicant doesn't exist        |
| 429         | Rate Limited     | Too many requests to KYC API   |
| 500         | Server Error     | Internal service error         |

### KYC Provider Errors

The service forwards errors from the Entrust API:

```json
{
  "error": "Failed to create applicant",
  "message": "Invalid API token"
}
```

## Testing

### Sandbox Environment

Use the sandbox environment for testing:

```bash
KYC_API_URL=https://api.eu.onfido.com/v3.6
KYC_API_KEY=api_sandbox_xxxxxxxxx
```

### Test Documents

Entrust provides sample documents for sandbox testing:

- Passports
- Driving licenses
- National ID cards

### Mock Webhooks

For testing webhook handling, you can simulate webhook events:

```bash
curl -X POST http://localhost:3000/api/kyc/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "action": "workflow_run.completed",
      "object": {
        "id": "test_workflow_run",
        "status": "completed"
      }
    }
  }'
```

## Security Considerations

1. **API Key Protection**
   - Never expose KYC API keys in frontend code
   - Use environment variables for configuration
   - Rotate keys regularly

2. **Webhook Security**
   - Verify webhook signatures using the secret
   - Use HTTPS for webhook endpoints
   - Implement request replay protection

3. **Data Privacy**
   - Minimize personal data collection
   - Implement data retention policies
   - Follow GDPR and local privacy laws

4. **Rate Limiting**
   - Implement client-side rate limiting
   - Monitor API usage and costs
   - Handle rate limit responses gracefully

## Monitoring and Logging

### Key Metrics to Monitor

- API request success/failure rates
- Verification completion times
- Webhook delivery success rates
- User KYC level distribution
- Transaction limit violations

### Logging

The KYC service logs important events:

```typescript
console.log(`KYC API Request: ${method} ${url}`);
console.log(`KYC API Response: ${status} ${url}`);
console.error(`KYC API Error: ${status} ${url}`, errorData);
```

## Troubleshooting

### Common Issues

1. **"Invalid API token"**
   - Check environment variable configuration
   - Verify token is not expired
   - Ensure correct environment (sandbox vs live)

2. **"Applicant not found"**
   - Verify applicant ID is correct
   - Check if applicant was created successfully

3. **"Document upload failed"**
   - Check file format and size
   - Verify base64 encoding
   - Ensure applicant exists

4. **"Webhook not received"**
   - Check webhook URL is accessible
   - Verify firewall configuration
   - Check webhook signature verification

### Debug Mode

Enable debug logging by setting:

```bash
DEBUG=kyc:*
```

## Future Enhancements

1. **Multi-Provider Support**
   - Add support for additional KYC providers
   - Provider failover mechanisms

2. **Advanced Workflows**
   - Custom verification workflows
   - Business verification options

3. **Analytics Dashboard**
   - KYC completion rates
   - Verification time analytics
   - User behavior insights

4. **Mobile SDK Integration**
   - Native mobile SDK support
   - Offline verification capabilities

## Support

- **Entrust Documentation**: https://documentation.identity.entrust.com/
- **API Reference**: https://documentation.identity.entrust.com/api/latest/
- **Support Portal**: https://support.identity.entrust.com/
- **Status Page**: https://onfido.statuspage.io/

## Changelog

### v1.0.0 (2024-01-15)

- Initial KYC integration
- Entrust Identity Verification provider
- Three-tier KYC levels with transaction limits
- Webhook support for real-time updates
- Comprehensive API documentation
