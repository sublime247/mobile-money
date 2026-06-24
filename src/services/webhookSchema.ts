import { z } from "zod";

export const SUPPORTED_VERSIONS = ["1.0.0", "2.0.0", "v1", "v2"] as const;

export const WebhookPayloadV1Schema = z.object({
  version: z.literal("1.0.0").or(z.literal("v1")),
  event_id: z.string().min(1),
  event_type: z.enum([
    "transaction.completed",
    "transaction.failed",
    "transaction.pending",
    "transaction.cancelled",
  ]),
  timestamp: z.string().datetime(),
  transaction_id: z.string().min(1),
  reference_number: z.string().min(1),
  transaction_type: z.enum(["deposit", "withdraw"]),
  amount: z.string().min(1),
  currency: z.string().min(1),
  phone_number: z.string().min(1),
  provider: z.string().min(1),
  stellar_address: z.string().min(1),
  status: z.enum(["pending", "completed", "failed", "cancelled"]),
  user_id: z.string().optional(),
  notes: z.string().optional(),
  tags: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
});

export const WebhookPayloadV2Schema = z.object({
  version: z.literal("2.0.0").or(z.literal("v2")),
  event_id: z.string().min(1),
  event_type: z.enum([
    "transaction.completed",
    "transaction.failed",
    "transaction.pending",
    "transaction.cancelled",
    "dispute.created",
    "dispute.resolved",
  ]),
  timestamp: z.string().datetime(),
  transaction_id: z.string().min(1),
  reference_number: z.string().min(1),
  transaction_type: z.enum(["deposit", "withdraw"]),
  amount: z.string().min(1),
  currency: z.string().min(1),
  phone_number: z.string().min(1),
  provider: z.string().min(1),
  stellar_address: z.string().min(1),
  status: z.enum(["pending", "completed", "failed", "cancelled"]),
  user_id: z.string().optional(),
  notes: z.string().optional(),
  tags: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
  // Extra V2 fields
  metadata: z.any().optional(),
  client_id: z.string().optional(),
});

export type WebhookPayloadV1 = z.infer<typeof WebhookPayloadV1Schema>;
export type WebhookPayloadV2 = z.infer<typeof WebhookPayloadV2Schema>;

/**
 * Dynamically validates a webhook payload based on its version number.
 * Rejects unsupported schemas.
 */
export function parseWebhookPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload: payload must be an object");
  }

  const raw = payload as Record<string, unknown>;
  const version = raw.version;

  if (typeof version !== "string") {
    throw new Error("Invalid payload: version is missing or is not a string");
  }

  if (version === "1.0.0" || version === "v1") {
    return WebhookPayloadV1Schema.parse(payload);
  } else if (version === "2.0.0" || version === "v2") {
    return WebhookPayloadV2Schema.parse(payload);
  } else {
    throw new Error(`Unsupported schema version: ${version}`);
  }
}
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
