# Make.com Webhook Integration Guide

This guide explains how to integrate Mobile Money webhooks with Make.com for no-code automation.

## Overview

Mobile Money provides flat, robust webhook payloads optimized for no-code platforms like Make.com and Zapier. The webhook structure is designed to be easily parsed and mapped without complex nested objects.

## Quick Setup

### 1. Create a Webhook in Make.com

1. Log in to your Make.com account
2. Create a new Scenario
3. Add the "Webhooks" module as the trigger
4. Select "Custom Webhook" 
5. Click "Add" to create a new webhook
6. Copy the webhook URL provided by Make.com
7. Keep the webhook configuration open - Make.com will wait for the first payload

### 2. Configure Mobile Money

Add the following environment variables to your Mobile Money application:

```bash
# The webhook URL from Make.com
WEBHOOK_URL=https://hook.make.com/your-webhook-id

# A secret key for signing webhooks (generate a secure random string)
WEBHOOK_SECRET=your-secure-webhook-secret-key-here
```

### 3. Send Test Payload

Use the sample payload endpoint to send a test payload to Make.com:

```bash
curl -X POST https://your-mobile-money-domain.com/api/webhooks/test \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "evt_test123",
    "event_type": "transaction.completed",
    "timestamp": "2026-03-27T11:46:00.000Z",
    "transaction_id": "txn_test123",
    "reference_number": "REF-TEST-001",
    "transaction_type": "deposit",
    "amount": "100.00",
    "currency": "USD",
    "phone_number": "+1234567890",
    "provider": "mpesa",
    "stellar_address": "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
    "status": "completed",
    "user_id": "user_test123",
    "created_at": "2026-03-27T11:45:00.000Z"
  }'
```

Make.com will automatically detect the structure and create data mapping templates.

## Webhook Schema

### Available Events

- `transaction.completed` - Transaction was successfully completed
- `transaction.failed` - Transaction failed
- `transaction.pending` - Transaction is pending processing
- `transaction.cancelled` - Transaction was cancelled

### Payload Structure

All webhook payloads use a flat structure for easy mapping:

```json
{
  "event_id": "evt_1234567890",
  "event_type": "transaction.completed",
  "timestamp": "2026-03-27T11:46:00.000Z",
  
  "transaction_id": "txn_abc123def456",
  "reference_number": "REF-20260327-001",
  "transaction_type": "deposit",
  "amount": "100.00",
  "currency": "USD",
  "phone_number": "+1234567890",
  "provider": "mpesa",
  "stellar_address": "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
  "status": "completed",
  
  "user_id": "user_789",
  "notes": "Test transaction",
  "tags": "test,deposit",
  
  "created_at": "2026-03-27T11:45:00.000Z",
  "updated_at": "2026-03-27T11:46:00.000Z",
  
  "metadata_key": "stellar_hash",
  "metadata_value": "abc123def456789...",
  
  "webhook_delivery_status": "delivered",
  "webhook_delivered_at": "2026-03-27T11:46:05.000Z"
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | string | Unique identifier for this webhook event |
| `event_type` | string | Type of event that occurred |
| `timestamp` | string | When the webhook was sent (ISO 8601) |
| `transaction_id` | string | Unique transaction identifier |
| `reference_number` | string | Human-readable transaction reference |
| `transaction_type` | string | "deposit" or "withdraw" |
| `amount` | string | Transaction amount |
| `currency` | string | Currency code (default: USD) |
| `phone_number` | string | Customer phone number |
| `provider` | string | Payment provider (mpesa, airtel, etc.) |
| `stellar_address` | string | Stellar wallet address |
| `status` | string | Transaction status |
| `user_id` | string | Optional user identifier |
| `notes` | string | Optional transaction notes |
| `tags` | string | Comma-separated transaction tags |
| `created_at` | string | When transaction was created |
| `updated_at` | string | When transaction was last updated |
| `metadata_key` | string | First metadata key (for easy access) |
| `metadata_value` | string | First metadata value (for easy access) |
| `webhook_delivery_status` | string | Delivery status of this webhook |
| `webhook_delivered_at` | string | When webhook was delivered |

## Schema Discovery Endpoints

### Get Webhook Schema

```bash
GET /api/webhooks/schema
```

Returns the complete webhook schema including field types, descriptions, and setup instructions.

### Get Sample Payload

```bash
GET /api/webhooks/sample
```

Returns a sample webhook payload that you can use for testing in Make.com.

## Common Make.com Integrations

### 1. Send SMS via Twilio

**Trigger**: Custom Webhook (Mobile Money)
**Action**: Twilio - Send SMS

Mapping:
- `phone_number` → To
- `amount` → Body (use text formatter: "Transaction of {{amount}} {{currency}} completed")
- `reference_number` → Body (add to message)

### 2. Add Row to Google Sheets

**Trigger**: Custom Webhook (Mobile Money)
**Action**: Google Sheets - Add a Row

Mapping:
- `transaction_id` → Column A (Transaction ID)
- `reference_number` → Column B (Reference)
- `amount` → Column C (Amount)
- `currency` → Column D (Currency)
- `status` → Column E (Status)
- `timestamp` → Column F (Timestamp)

### 3. Send Email via Gmail

**Trigger**: Custom Webhook (Mobile Money)
**Action**: Gmail - Send an Email

Mapping:
- `user_id` → To (you may need to look up email from user ID)
- `reference_number` → Subject ("Transaction {{reference_number}} Update")
- `amount` + `status` → Body (format transaction details)

### 4. Post to Slack

**Trigger**: Custom Webhook (Mobile Money)
**Action**: Slack - Post a Message

Mapping:
- `#transactions` → Channel
- `transaction_type` → Channel (use router to send to different channels)
- `amount` + `currency` → Text ("{{transaction_type}}: {{amount}} {{currency}}")
- `reference_number` → Text (add reference)

### 5. Create HubSpot Contact

**Trigger**: Custom Webhook (Mobile Money)
**Action**: HubSpot - Create a Contact

Mapping:
- `phone_number` → Phone
- Create email from phone number if needed
- `transaction_type` → Lifecycle stage (based on transaction type)

### 6. Update Airtable Record

**Trigger**: Custom Webhook (Mobile Money)
**Action**: Airtable - Update Record

Mapping:
- `transaction_id` → Find record by Transaction ID
- `status` → Status field
- `updated_at` → Last Updated field

## Advanced Make.com Features

### 1. Route by Event Type

Use the "Router" module to handle different event types:

```
Webhook → Router → [transaction.completed] → SMS Module
                    → [transaction.failed] → Email Module  
                    → [transaction.pending] → Slack Module
```

### 2. Filter by Amount

Use the "Filter" module to process only high-value transactions:

```
Webhook → Filter (amount > 1000) → Manager Notification Module
```

### 3. Aggregate Data

Use the "Array Aggregator" to collect multiple transactions:

```
Multiple Webhooks → Array Aggregator → Daily Summary Email
```

### 4. Data Transformation

Use the "Text Parser" and "Date/Time" modules to format data:

```
Webhook → Text Parser (parse tags) → Multiple Actions
```

## Security

### Webhook Signature Verification

Mobile Money signs all webhook payloads using HMAC-SHA256. The signature is sent in the `X-Webhook-Signature` header.

To verify the signature in Make.com:

1. Add a "Code" module after the webhook
2. Use JavaScript to verify the signature:
   ```javascript
   const crypto = require('crypto');
   const webhookSecret = 'your-webhook-secret';
   const payload = JSON.stringify(body);
   const signature = crypto.createHmac('sha256', webhookSecret)
     .update(payload)
     .digest('hex');
   const expectedSignature = `sha256=${signature}`;
   
   // Compare signatures
   if (headers['x-webhook-signature'] === expectedSignature) {
     return { valid: true };
   } else {
     return { valid: false };
   }
   ```
3. Add a filter to only process valid webhooks

### Recommended Security Practices

1. **Use HTTPS**: Always use HTTPS URLs for your webhooks
2. **Verify Signatures**: Always verify webhook signatures
3. **Unique Secrets**: Use a unique, strong secret for each environment
4. **Rate Limiting**: Make.com handles rate limiting automatically
5. **Error Handling**: Set up error handling for failed webhook deliveries

## Troubleshooting

### Webhook Not Received

1. Check the webhook URL is correct in Make.com
2. Verify `WEBHOOK_URL` is set in environment variables
3. Check webhook delivery logs in Mobile Money
4. Test with the `/api/webhooks/test` endpoint
5. Verify Make.com scenario is turned on

### Data Mapping Issues

1. Use the `/api/webhooks/sample` endpoint to see expected format
2. Re-detect the webhook structure in Make.com
3. Check that all required fields are present
4. Verify field types (use text/number converters if needed)

### Scenario Not Triggering

1. Check Make.com scenario is active
2. Verify webhook is properly connected
3. Check Make.com execution history
4. Look for error messages in the scenario logs

### Performance Issues

1. Use batch processing for multiple webhooks
2. Set appropriate scheduling (immediate for critical events)
3. Use Make.com's error handling and retry features
4. Monitor webhook processing times

## Testing

### Using Make.com's Test Feature

1. Set up your webhook trigger in Make.com
2. Send a test payload:
   ```bash
   curl -X POST https://your-mobile-money-domain.com/api/webhooks/test \
     -H "Content-Type: application/json" \
     -d '{"test": true, "amount": "50.00"}'
   ```
3. Check that Make.com receives and processes the payload
4. Map fields in Make.com using the detected structure

### Local Testing

Use ngrok to test webhooks locally:

```bash
ngrok http 3000
```

Then update your `WEBHOOK_URL` to use the ngrok URL and forward to your local Make.com tunnel.

## Best Practices

### 1. Scenario Design

- Keep scenarios simple and focused
- Use routers for complex logic
- Add error handling at each step
- Log important actions for debugging

### 2. Data Management

- Use consistent field naming
- Validate data before processing
- Handle null/undefined values gracefully
- Use data transformations when needed

### 3. Performance

- Use immediate scheduling for critical events
- Batch non-critical operations
- Monitor scenario execution times
- Optimize API calls and data processing

### 4. Monitoring

- Set up notifications for failed scenarios
- Monitor webhook delivery rates
- Track processing times
- Log important business events

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `WEBHOOK_URL` | Yes | URL to send webhook payloads to |
| `WEBHOOK_SECRET` | Yes | Secret key for signing webhooks |
| `WEBHOOK_MAX_ATTEMPTS` | No | Maximum delivery attempts (default: 3) |
| `WEBHOOK_BASE_DELAY_MS` | No | Base delay between retries (default: 500) |

## Support

For issues with Make.com integration:

1. Check the Mobile Money application logs
2. Verify webhook delivery status in the database
3. Test with the provided test endpoints
4. Check Make.com scenario execution history
5. Ensure your Make.com setup matches the webhook schema
