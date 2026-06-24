import { z } from 'zod';

export const webhookPayloadSchema = z.object({
  event: z.string(),
  timestamp: z.string(),
  data: z.record(z.string(), z.string()),
});

export const flatWebhookPayloadSchema = z.object({
  event_id: z.string(),
  event_type: z.string(),
  timestamp: z.string(),
  transaction_id: z.string(),
  reference_number: z.string(),
  transaction_type: z.enum(['deposit', 'withdraw']),
  amount: z.string(),
  currency: z.string(),
  phone_number: z.string(),
  provider: z.string(),
  stellar_address: z.string(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  user_id: z.string().optional(),
  notes: z.string().optional(),
  tags: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  metadata_key: z.string().optional(),
  metadata_value: z.string().optional(),
  webhook_delivery_status: z.string().optional(),
  webhook_delivered_at: z.string().optional(),
});
