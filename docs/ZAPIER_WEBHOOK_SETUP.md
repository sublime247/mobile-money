# Zapier Webhook Integration Guide

This guide explains how to integrate Mobile Money webhooks with Zapier for no-code automation.

## Overview

Mobile Money provides flat, robust webhook payloads optimized for no-code platforms like Zapier and Make.com. The webhook structure is designed to be easily parsed and mapped without complex nested objects.

## Quick Setup

### 1. Get Your Webhook URL

1. Log in to your Zapier account
2. Create a new Zap
3. Choose "Webhooks by Zapier" as the trigger
4. Select "Catch Hook" as the trigger event
5. Copy the webhook URL provided by Zapier

### 2. Configure Mobile Money

Add the following environment variables to your Mobile Money application:

```bash
# The webhook URL from Zapier
WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/123456/abcdef/

# A secret key for signing webhooks (generate a secure random string)
WEBHOOK_SECRET=your-secure-webhook-secret-key-here
```

### 3. Test the Webhook

Use the sample payload endpoint to test:

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

Returns a sample webhook payload that you can use for testing in Zapier.

## Security

### Webhook Signature Verification

Mobile Money signs all webhook payloads using HMAC-SHA256. The signature is sent in the `X-Webhook-Signature` header.

To verify the signature in Zapier:

1. Use the "Code by Zapier" action
2. Extract the signature from the `X-Webhook-Signature` header
3. Compute the expected signature:
   ```javascript
   const crypto = require('crypto');
   const signature = crypto.createHmac('sha256', WEBHOOK_SECRET)
     .update(JSON.stringify(payload))
     .digest('hex');
   const expectedSignature = `sha256=${signature}`;
   ```
4. Compare with the received signature

### Recommended Security Practices

1. **Use HTTPS**: Always use HTTPS URLs for your webhooks
2. **Verify Signatures**: Always verify webhook signatures
3. **Unique Secrets**: Use a unique, strong secret for each environment
4. **Rate Limiting**: Implement rate limiting on your webhook endpoints
5. **Idempotency**: Handle duplicate webhooks gracefully using the `event_id`

## Common Zapier Integrations

### 1. Send SMS Notifications

**Trigger**: Mobile Money Webhook (transaction.completed)
**Action**: Twilio Send SMS

Map fields:
- `phone_number` → To
- `amount` → Message body (with formatting)
- `reference_number` → Message body

### 2. Update Google Sheets

**Trigger**: Mobile Money Webhook (transaction.completed)
**Action**: Google Sheets Add Row

Map fields:
- `transaction_id` → Column A
- `reference_number` → Column B
- `amount` → Column C
- `status` → Column D
- `timestamp` → Column E

### 3. Send Email Notifications

**Trigger**: Mobile Money Webhook (transaction.failed)
**Action**: Gmail Send Email

Map fields:
- `user_id` → To (lookup user email)
- `reference_number` → Subject
- `amount` + `status` → Body

### 4. Create Slack Notifications

**Trigger**: Mobile Money Webhook (transaction.completed)
**Action**: Slack Send Message

Map fields:
- `transaction_type` → Channel (based on type)
- `amount` + `currency` → Message
- `reference_number` → Message

## Troubleshooting

### Webhook Not Received

1. Check the webhook URL is correct
2. Verify `WEBHOOK_URL` is set in environment variables
3. Check webhook delivery logs in Mobile Money
4. Test with the `/api/webhooks/test` endpoint

### Signature Verification Failed

1. Ensure `WEBHOOK_SECRET` matches between sender and receiver
2. Check you're using the raw payload (not parsed) for signature calculation
3. Verify the signature format: `sha256=<hex-string>`

### Payload Parsing Issues

1. Use the `/api/webhooks/sample` endpoint to see expected format
2. Check that all required fields are present
3. Verify field types match your expectations

## Testing

### Using Zapier's Test Feature

1. Set up your webhook trigger in Zapier
2. Send a test payload using curl:
   ```bash
   curl -X POST https://your-mobile-money-domain.com/api/webhooks/test \
     -H "Content-Type: application/json" \
     -H "X-Webhook-Signature: sha256=test" \
     -d '{"test": true}'
   ```
3. Check that Zapier receives the payload
4. Map fields in Zapier using the sample data

### Local Testing

Use ngrok to test webhooks locally:

```bash
ngrok http 3000
```

Then update your `WEBHOOK_URL` to use the ngrok URL.

## Support

For issues with webhook integration:

1. Check the Mobile Money application logs
2. Verify webhook delivery status in the database
3. Test with the provided test endpoints
4. Ensure your Zapier setup matches the schema

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `WEBHOOK_URL` | Yes | URL to send webhook payloads to |
| `WEBHOOK_SECRET` | Yes | Secret key for signing webhooks |
| `WEBHOOK_MAX_ATTEMPTS` | No | Maximum delivery attempts (default: 3) |
| `WEBHOOK_BASE_DELAY_MS` | No | Base delay between retries (default: 500) |
