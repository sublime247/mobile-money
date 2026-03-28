import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { WebhookService, WebhookEvent } from "../services/webhook";

const router = Router();
const transactionModel = new TransactionModel();

/**
 * Flat webhook payload structure optimized for Zapier/Make.com
 * All fields are at the root level for easy mapping in no-code tools
 */
export interface FlatWebhookPayload {
  // Event metadata
  event_id: string;
  event_type: "transaction.completed" | "transaction.failed" | "transaction.pending" | "transaction.cancelled";
  timestamp: string;
  
  // Transaction core fields (flat structure)
  transaction_id: string;
  reference_number: string;
  transaction_type: "deposit" | "withdraw";
  amount: string;
  currency: string;
  phone_number: string;
  provider: string;
  stellar_address: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  
  // Optional fields
  user_id?: string;
  notes?: string;
  tags?: string;
  
  // Timestamps
  created_at: string;
  updated_at?: string;
  
  // Metadata (flattened key-value pairs)
  metadata_key?: string;
  metadata_value?: string;
  
  // Processing info
  webhook_delivery_status?: string;
  webhook_delivered_at?: string;
}

/**
 * Sample webhook payload for schema discovery
 * This helps Zapier/Make.com understand the webhook structure
 */
export const SAMPLE_WEBHOOK_PAYLOAD: FlatWebhookPayload = {
  event_id: "evt_1234567890",
  event_type: "transaction.completed",
  timestamp: "2026-03-27T11:46:00.000Z",
  
  transaction_id: "txn_abc123def456",
  reference_number: "REF-20260327-001",
  transaction_type: "deposit",
  amount: "100.00",
  currency: "USD",
  phone_number: "+1234567890",
  provider: "mpesa",
  stellar_address: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
  status: "completed",
  
  user_id: "user_789",
  notes: "Test transaction",
  tags: "test,deposit",
  
  created_at: "2026-03-27T11:45:00.000Z",
  updated_at: "2026-03-27T11:46:00.000Z",
  
  metadata_key: "stellar_hash",
  metadata_value: "abc123def456789...",
  
  webhook_delivery_status: "delivered",
  webhook_delivered_at: "2026-03-27T11:46:05.000Z"
};

/**
 * Convert transaction to flat webhook payload
 */
function transactionToFlatPayload(
  event: WebhookEvent,
  transaction: any,
  eventId: string
): FlatWebhookPayload {
  const payload: FlatWebhookPayload = {
    event_id: eventId,
    event_type: event,
    timestamp: new Date().toISOString(),
    
    transaction_id: transaction.id,
    reference_number: transaction.referenceNumber,
    transaction_type: transaction.type,
    amount: transaction.amount,
    currency: transaction.currency || "USD",
    phone_number: transaction.phoneNumber,
    provider: transaction.provider,
    stellar_address: transaction.stellarAddress,
    status: transaction.status,
    
    user_id: transaction.userId || undefined,
    notes: transaction.notes || undefined,
    tags: transaction.tags ? transaction.tags.join(",") : undefined,
    
    created_at: transaction.createdAt.toISOString(),
    updated_at: transaction.updatedAt ? transaction.updatedAt.toISOString() : undefined,
    
    webhook_delivery_status: transaction.webhook_delivery_status,
    webhook_delivered_at: transaction.webhook_delivered_at ? transaction.webhook_delivered_at.toISOString() : undefined
  };

  // Flatten first metadata key-value pair for easy access
  if (transaction.metadata && typeof transaction.metadata === "object") {
    const entries = Object.entries(transaction.metadata);
    if (entries.length > 0) {
      payload.metadata_key = entries[0][0];
      payload.metadata_value = String(entries[0][1]);
    }
  }

  return payload;
}

/**
 * Generate unique event ID
 */
function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Verify webhook signature for incoming webhooks
 */
function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature = signature.substring(7);
  const computedSignature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (expectedSignature.length !== computedSignature.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(computedSignature),
  );
}

/**
 * GET /webhooks/schema - Returns webhook schema for discovery
 * This endpoint helps Zapier/Make.com understand the webhook structure
 */
router.get("/schema", (req: Request, res: Response) => {
  res.json({
    name: "Mobile Money Webhooks",
    description: "Flat webhook payloads optimized for no-code automation platforms",
    version: "1.0.0",
    events: [
      "transaction.completed",
      "transaction.failed", 
      "transaction.pending",
      "transaction.cancelled"
    ],
    sample_payload: SAMPLE_WEBHOOK_PAYLOAD,
    schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Unique event identifier" },
        event_type: { type: "string", enum: ["transaction.completed", "transaction.failed", "transaction.pending", "transaction.cancelled"] },
        timestamp: { type: "string", format: "date-time" },
        transaction_id: { type: "string" },
        reference_number: { type: "string" },
        transaction_type: { type: "string", enum: ["deposit", "withdraw"] },
        amount: { type: "string" },
        currency: { type: "string" },
        phone_number: { type: "string" },
        provider: { type: "string" },
        stellar_address: { type: "string" },
        status: { type: "string", enum: ["pending", "completed", "failed", "cancelled"] },
        user_id: { type: "string" },
        notes: { type: "string" },
        tags: { type: "string" },
        created_at: { type: "string", format: "date-time" },
        updated_at: { type: "string", format: "date-time" },
        metadata_key: { type: "string" },
        metadata_value: { type: "string" },
        webhook_delivery_status: { type: "string" },
        webhook_delivered_at: { type: "string", format: "date-time" }
      }
    },
    setup_instructions: {
      zapier: {
        webhook_url: `${req.protocol}://${req.get('host')}/api/webhooks`,
        authentication: "X-Webhook-Signature header with HMAC-SHA256",
        sample_payload_url: `${req.protocol}://${req.get('host')}/api/webhooks/sample`
      },
      make_com: {
        webhook_url: `${req.protocol}://${req.get('host')}/api/webhooks`,
        authentication: "X-Webhook-Signature header with HMAC-SHA256", 
        sample_payload_url: `${req.protocol}://${req.get('host')}/api/webhooks/sample`
      }
    }
  });
});

/**
 * GET /webhooks/sample - Returns a sample webhook payload
 * Used by no-code platforms to understand the data structure
 */
router.get("/sample", (req: Request, res: Response) => {
  res.json(SAMPLE_WEBHOOK_PAYLOAD);
});

/**
 * POST /webhooks - Main webhook endpoint for receiving events
 * Compatible with Zapier/Make.com webhook receivers
 */
router.post("/", async (req: Request, res: Response) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[webhook] WEBHOOK_SECRET not configured");
    return res.status(500).json({ 
      error: "Webhook processing not configured",
      setup_url: `${req.protocol}://${req.get('host')}/api/webhooks/schema`
    });
  }

  const signature = req.headers["x-webhook-signature"] as string | undefined;
  const rawPayload = JSON.stringify(req.body);

  if (!verifyWebhookSignature(rawPayload, signature, webhookSecret)) {
    console.warn("[webhook] Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  try {
    // Process the flat webhook payload
    const payload = req.body as FlatWebhookPayload;
    
    // Validate required fields
    if (!payload.transaction_id || !payload.event_type) {
      console.warn("[webhook] Missing required fields", payload);
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Find and update the transaction if it exists
    const transaction = await transactionModel.findById(payload.transaction_id);
    
    if (!transaction) {
      console.warn(`[webhook] Transaction not found: ${payload.transaction_id}`);
      return res.status(404).json({ 
        error: "Transaction not found",
        transaction_id: payload.transaction_id
      });
    }

    // Update transaction status if needed
    if (payload.status && payload.status !== transaction.status) {
      const newStatus = payload.status as TransactionStatus;
      await transactionModel.updateStatus(transaction.id, newStatus);
      console.log(`[webhook] Updated transaction ${transaction.id} to ${newStatus}`);
    }

    // Log successful processing
    console.log(`[webhook] Processed event ${payload.event_id} for transaction ${payload.transaction_id}`);

    return res.status(200).json({
      success: true,
      event_id: payload.event_id,
      transaction_id: payload.transaction_id,
      processed_at: new Date().toISOString()
    });

  } catch (error) {
    console.error("[webhook] Processing error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /webhooks/test - Test endpoint for webhook delivery testing
 * Returns the received payload for debugging
 */
router.post("/test", (req: Request, res: Response) => {
  console.log("[webhook-test] Received payload:", req.body);
  res.json({
    received: true,
    timestamp: new Date().toISOString(),
    payload: req.body,
    headers: {
      'content-type': req.get('content-type'),
      'x-webhook-signature': req.get('x-webhook-signature'),
      'user-agent': req.get('user-agent')
    }
  });
});

export default router;
