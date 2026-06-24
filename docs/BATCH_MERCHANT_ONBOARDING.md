# Batch Merchant Onboarding via CSV

## Overview

The Batch Merchant Onboarding feature allows administrators to invite 100+ merchants at once using a CSV upload. This feature is designed to enable faster scaling for large partner networks.

## Features

- **CSV Upload**: Upload a CSV file containing merchant data
- **Bulk Processing**: Asynchronous processing of merchant invitations
- **Email Invitations**: Automatic invitation emails sent to merchants
- **Partial Error Handling**: Detailed error reporting for failed rows
- **Job Status Tracking**: Monitor the progress of bulk imports
- **Validation**: Comprehensive validation of merchant data before processing

## Database Schema

### Merchants Table

```sql
CREATE TABLE merchants (
  id              UUID        PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  email           VARCHAR(255) NOT NULL UNIQUE,
  phone_number    VARCHAR(20)  NOT NULL,
  business_name   VARCHAR(255),
  business_type   VARCHAR(100),
  tax_id          VARCHAR(50),
  address         TEXT,
  city            VARCHAR(100),
  country         VARCHAR(100) DEFAULT 'CM',
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
  kyc_status      VARCHAR(20)  NOT NULL DEFAULT 'not_started',
  invitation_token VARCHAR(255),
  invitation_sent_at TIMESTAMP,
  invitation_accepted_at TIMESTAMP,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Merchant Batch Jobs Table

```sql
CREATE TABLE merchant_batch_jobs (
  id                UUID        PRIMARY KEY,
  job_id            VARCHAR(255) NOT NULL UNIQUE,
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending',
  total_records     INTEGER      NOT NULL DEFAULT 0,
  processed_records INTEGER      NOT NULL DEFAULT 0,
  succeeded_records INTEGER      NOT NULL DEFAULT 0,
  failed_records    INTEGER      NOT NULL DEFAULT 0,
  errors            JSONB        DEFAULT '[]',
  created_by        UUID         NOT NULL REFERENCES users(id),
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at      TIMESTAMP
);
```

## CSV Format

The CSV file must contain the following headers:

| Column | Required | Description | Validation |
|--------|----------|-------------|------------|
| name | Yes | Contact person's full name | Max 255 characters |
| email | Yes | Merchant's email address | Valid email format |
| phone_number | Yes | Contact phone number | 7-15 digits |
| business_name | No | Business/Company name | Max 255 characters |
| business_type | No | Type of business | Max 100 characters |
| tax_id | No | Tax identification number | Max 50 characters |
| address | No | Business address | - |
| city | No | City | Max 100 characters |
| country | No | ISO 3166-1 alpha-2 code | 2 uppercase letters (default: CM) |

### Example CSV

```csv
name,email,phone_number,business_name,business_type,tax_id,address,city,country
John Doe,john@example.com,+237670000000,John's Store,Retail,TAX123,123 Main St,Douala,CM
Jane Smith,jane@example.com,+237671000000,Jane's Shop,Food Service,TAX456,456 Market St,Yaounde,CM
```

## API Endpoints

### 1. Create Single Merchant

```
POST /api/merchants
```

**Request Body:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "phone_number": "+237670000000",
  "business_name": "John's Store",
  "business_type": "Retail",
  "country": "CM"
}
```

**Response (201 Created):**
```json
{
  "message": "Merchant invitation sent successfully",
  "merchant": {
    "id": "uuid",
    "name": "John Doe",
    "email": "john@example.com",
    "status": "pending",
    "createdAt": "2026-06-01T00:00:00.000Z"
  }
}
```

### 2. Bulk Import Merchants via CSV

```
POST /api/merchants/bulk
Content-Type: multipart/form-data
```

**Form Data:**
- `file`: CSV file (max 10MB)

**Response (202 Accepted):**
```json
{
  "jobId": "uuid",
  "total": 100,
  "message": "Bulk merchant import queued - 100 merchant(s) will be processed",
  "statusUrl": "/api/merchants/bulk/uuid"
}
```

### 3. Get Bulk Import Job Status

```
GET /api/merchants/bulk/:jobId
```

**Response (200 OK):**
```json
{
  "jobId": "uuid",
  "status": "completed",
  "progress": {
    "total": 100,
    "processed": 100,
    "succeeded": 95,
    "failed": 5
  },
  "errors": [
    {
      "row": 15,
      "error": "Duplicate email: existing@example.com",
      "email": "existing@example.com"
    }
  ],
  "createdAt": "2026-06-01T00:00:00.000Z",
  "completedAt": "2026-06-01T00:05:00.000Z"
}
```

### 4. List Merchants

```
GET /api/merchants?page=1&limit=50&status=pending&kycStatus=not_started
```

**Response (200 OK):**
```json
{
  "merchants": [...],
  "total": 100,
  "pagination": {
    "page": 1,
    "limit": 50,
    "totalPages": 2
  }
}
```

### 5. Get Merchant by ID

```
GET /api/merchants/:id
```

### 6. Accept Merchant Invitation

```
POST /api/merchants/invite/:token/accept
```

**Response (200 OK):**
```json
{
  "message": "Invitation accepted successfully",
  "merchant": {
    "id": "uuid",
    "name": "John Doe",
    "email": "john@example.com",
    "status": "active"
  }
}
```

## Error Handling

### Validation Errors (422 Unprocessable Entity)

When CSV validation fails, the API returns detailed validation errors:

```json
{
  "error": "CSV validation failed",
  "totalErrors": 3,
  "validationErrors": [
    {
      "row": 2,
      "field": "name",
      "message": "Name is required"
    },
    {
      "row": 2,
      "field": "email",
      "message": "Valid email is required"
    },
    {
      "row": 3,
      "field": "phone_number",
      "message": "Valid phone number is required (7-15 digits)"
    }
  ],
  "message": "Please fix the validation errors and try again"
}
```

### Processing Errors

During bulk processing, some rows may fail due to:
- Duplicate email addresses
- Database constraint violations
- System errors

These errors are captured and returned in the job status response, allowing successful merchants to be processed while failed ones are reported.

## Email Invitation Flow

1. Admin uploads CSV with merchant data
2. System validates all rows
3. Valid merchants are created with `pending` status
4. Invitation email is sent with unique token
5. Merchant clicks invitation link
6. Merchant account is activated (`active` status)

### Invitation Email Template

The invitation email includes:
- Personalized greeting
- Business name (if provided)
- Accept invitation button/link
- Expiration notice (7 days)
- Security notice

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FRONTEND_URL` | URL for invitation links | `https://app.mobilemoney.com` |
| `SENDGRID_MERCHANT_INVITATION_TEMPLATE_ID` | SendGrid template ID | - |
| `EMAIL_FROM` | Sender email address | `"Mobile Money" <no-reply@mobilemoney.com>` |

## Running Migrations

Apply the database migrations:

```bash
npm run migrate:up
```

Or manually run the migration:

```bash
psql -d mobile_money -f migrations/20260601_create_merchants_table.sql
```

## Testing

Run the test suite:

```bash
npm test -- --testPathPattern=merchants
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Admin Dashboard                          │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    POST /api/merchants/bulk                      │
│                         (CSV Upload)                             │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CSV Parser & Validator                      │
│  - Parse CSV file                                               │
│  - Validate each row (name, email, phone, country)              │
│  - Deduplicate by email                                         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      MerchantService                             │
│  - Create batch job record                                      │
│  - Process merchants asynchronously                             │
│  - Send invitation emails                                       │
│  - Update job status                                            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Database                                  │
│  - merchants table                                              │
│  - merchant_batch_jobs table                                    │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Email Service                               │
│  - Send invitation emails via SendGrid                          │
│  - Fallback HTML template                                       │
└─────────────────────────────────────────────────────────────────┘
```

## Security Considerations

1. **Admin Access Only**: All merchant endpoints require admin authentication
2. **Rate Limiting**: Bulk import is rate-limited to prevent abuse
3. **File Size Limits**: CSV uploads are limited to 10MB
4. **Input Validation**: All inputs are validated before processing
5. **Secure Tokens**: Invitation tokens are cryptographically random (32 bytes)
6. **Token Expiration**: Invitation tokens expire after 7 days

## Performance

- **Batch Size**: Maximum 1000 merchants per upload
- **Processing**: Asynchronous background processing
- **Database**: Batch inserts with individual error handling
- **Email**: Non-blocking email sending (failures don't block processing)

## Future Enhancements

1. Webhook notifications for job completion
2. Downloadable error report (CSV format)
3. Scheduled/deferred processing
4. Merchant group tagging
5. Bulk update/edit capabilities
6. CSV template download