# SEP-12: KYC API Implementation

This document describes the implementation of SEP-12 (KYC API) for the Mobile Money to Stellar platform.

## Overview

SEP-12 defines a standard API for anchors to collect and manage customer information for KYC (Know Your Customer) compliance. This implementation integrates with our internal KYC system (Entrust/Onfido) to provide a standardized interface for Stellar wallets and applications.

## Specification

- **Standard**: [SEP-12: KYC API](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md)
- **Version**: 1.0
- **Base URL**: `/sep12`

## Endpoints

### GET /customer

Retrieve customer information and KYC status.

**Query Parameters:**
- `account` (required): Stellar account address (G...)
- `memo` (optional): Memo value for account identification
- `memo_type` (optional): Type of memo (id, hash, text)
- `type` (optional): Customer type (default: natural person, or "organization")

**Response:**

```json
{
  "id": "user-uuid",
  "status": "ACCEPTED|PROCESSING|NEEDS_INFO|REJECTED",
  "fields": {
    "first_name": {
      "type": "string",
      "description": "First or given name",
      "optional": false
    },
    "last_name": {
      "type": "string",
      "description": "Last or family name",
      "optional": false
    }
  },
  "provided_fields": {
    "first_name": {
      "type": "string",
      "description": "First name"
    }
  },
  "message": "Additional information required for verification"
}
```

**Status Values:**
- `ACCEPTED`: Customer is fully verified and approved
- `PROCESSING`: Customer information is being reviewed
- `NEEDS_INFO`: Additional information is required
- `REJECTED`: Customer verification was rejected

### PUT /customer

Create or update customer information.

**Request Body:**

```json
{
  "account": "GABC123...",
  "first_name": "John",
  "last_name": "Doe",
  "email_address": "john@example.com",
  "mobile_number": "+1234567890",
  "birth_date": "1990-01-15",
  "address": "123 Main St",
  "city": "New York",
  "state_or_province": "NY",
  "postal_code": "10001",
  "address_country_code": "USA",
  "id_type": "passport",
  "id_number": "AB123456",
  "id_country_code": "USA",
  "photo_id_front": "base64_encoded_image...",
  "photo_id_back": "base64_encoded_image..."
}
```

**Response:**

```json
{
  "id": "user-uuid",
  "status": "PROCESSING",
  "message": "Customer information received and is being processed"
}
```

### DELETE /customer/:account

Delete customer information (GDPR compliance).

**Parameters:**
- `account` (required): Stellar account address

**Response:**
- Status: 204 No Content

## Field Definitions

### Natural Person Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| first_name | string | Yes | First or given name |
| last_name | string | Yes | Last or family name |
| email_address | string | Yes | Email address |
| mobile_number | string | No | Mobile phone with country code |
| birth_date | date | Yes | Date of birth (YYYY-MM-DD) |
| address | string | Yes | Full street address |
| city | string | Yes | City of residence |
| postal_code | string | Yes | Postal or ZIP code |
| address_country_code | string | Yes | ISO 3166-1 alpha-3 country code |
| id_type | string | Yes* | Type of ID document |
| id_number | string | Yes* | ID document number |
| id_country_code | string | Yes* | Country that issued the ID |
| photo_id_front | binary | Yes* | Image of front of ID |
| photo_id_back | binary | No | Image of back of ID |

*Required for KYC verification levels above basic

### Organization Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| organization_name | string | Yes | Legal name of organization |
| organization_registration_number | string | Yes | Business registration number |
| organization_registered_address | string | Yes | Registered business address |
| address_country_code | string | Yes | ISO 3166-1 alpha-3 country code |

### ID Types

Supported ID document types:
- `passport`: International passport
- `drivers_license`: Driver's license
- `national_id`: National identity card
- `residence_permit`: Residence permit

## Integration with Internal KYC System

The SEP-12 implementation maps to our internal KYC system:

### Status Mapping

| Internal Status | KYC Level | SEP-12 Status |
|----------------|-----------|---------------|
| PENDING | NONE | NEEDS_INFO |
| PENDING | BASIC | PROCESSING |
| APPROVED | BASIC | NEEDS_INFO |
| APPROVED | FULL | ACCEPTED |
| REJECTED | * | REJECTED |
| REVIEW | * | PROCESSING |

### Data Flow

1. **Customer Submission** (PUT /customer)
   - Create/update user record with Stellar address
   - Create KYC applicant in Entrust/Onfido
   - Upload documents if provided
   - Link applicant to user

2. **Status Check** (GET /customer)
   - Query user by Stellar address
   - Fetch KYC applicant data
   - Map internal status to SEP-12 status
   - Return required/provided fields

3. **Verification Process**
   - Entrust/Onfido processes documents
   - Webhook updates internal status
   - KYC level updated based on verification
   - Transaction limits adjusted

## Database Schema

### Users Table

```sql
ALTER TABLE users 
ADD COLUMN stellar_address VARCHAR(56);

CREATE INDEX idx_users_stellar_address ON users(stellar_address);
```

### KYC Applicants Table

```sql
CREATE TABLE kyc_applicants (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  applicant_id VARCHAR(255) NOT NULL,
  provider VARCHAR(50) DEFAULT 'entrust',
  verification_status VARCHAR(20),
  kyc_level VARCHAR(20),
  applicant_data JSONB,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  UNIQUE(user_id, applicant_id)
);
```

## Testing

Run the test suite:

```bash
npm test src/stellar/__tests__/sep12.test.ts
```

### Test Coverage

- ✅ GET /customer for new customers
- ✅ GET /customer for existing customers
- ✅ GET /customer with different KYC levels
- ✅ PUT /customer to create new customer
- ✅ PUT /customer to update existing customer
- ✅ PUT /customer with document uploads
- ✅ DELETE /customer for GDPR compliance
- ✅ Field requirements for natural persons
- ✅ Field requirements for organizations
- ✅ Status mapping from internal KYC system

## Stellar Validator Compliance

To pass the Stellar validator:

1. **Required Endpoints**: ✅ GET, PUT, DELETE /customer
2. **Status Values**: ✅ ACCEPTED, PROCESSING, NEEDS_INFO, REJECTED
3. **Field Definitions**: ✅ Proper field types and descriptions
4. **Error Handling**: ✅ Appropriate HTTP status codes
5. **Rate Limiting**: ✅ 20 requests per minute

## Usage Example

### Wallet Integration

```javascript
// Check customer status
const response = await fetch('https://api.example.com/sep12/customer?account=GABC123...');
const customer = await response.json();

if (customer.status === 'NEEDS_INFO') {
  // Collect required fields
  const fields = customer.fields;
  
  // Submit customer information
  await fetch('https://api.example.com/sep12/customer', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account: 'GABC123...',
      first_name: 'John',
      last_name: 'Doe',
      email_address: 'john@example.com',
      // ... other required fields
    })
  });
}
```

## Security Considerations

1. **Authentication**: Consider implementing SEP-10 authentication for production
2. **Rate Limiting**: 20 requests per minute per IP
3. **Data Privacy**: Customer data is encrypted at rest
4. **GDPR Compliance**: DELETE endpoint for data removal
5. **Document Security**: Documents stored in encrypted S3 bucket

## Configuration

Environment variables:

```env
# KYC Provider
KYC_API_URL=https://api.entrust.com
KYC_API_KEY=your_api_key
KYC_WEBHOOK_SECRET=your_webhook_secret

# Transaction Limits
LIMIT_UNVERIFIED=10000
LIMIT_BASIC=100000
LIMIT_FULL=1000000
```

## Monitoring

Key metrics to monitor:
- Customer submission rate
- Verification processing time
- Approval/rejection rates
- API response times
- Error rates

## Future Enhancements

- [ ] SEP-10 authentication integration
- [ ] Webhook notifications for status changes
- [ ] Multi-language support
- [ ] Enhanced document validation
- [ ] Biometric verification support
- [ ] Real-time status updates via WebSocket

## References

- [SEP-12 Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md)
- [Stellar Anchor Platform](https://github.com/stellar/stellar-anchor-platform)
- [Entrust Identity Verification](https://www.entrust.com/digital-security/identity-verification)
