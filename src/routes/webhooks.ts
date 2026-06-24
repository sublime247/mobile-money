import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { WebhookService, WebhookEvent } from "../services/webhook";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";

const router = Router();
const transactionModel = new TransactionModel();

// Rate-limit ingest traffic before signature verification and DB writes.
router.use(ingestRateLimiter);

interface WebhookSettings {
  compression: boolean;
}

const webhookSettings: WebhookSettings = {
  compression: process.env.WEBHOOK_COMPRESSION === "true",
};

export interface FlatWebhookPayload {
  event_id: string;
  event_type: "transaction.completed" | "transaction.failed" | "transaction.pending" | "transaction.cancelled";
  timestamp: string;
  transaction_id: string;
  reference_number: string;
  transaction_type: "deposit" | "withdraw";
  amount: string;
  currency: string;
  phone_number: string;
  provider: string;
  stellar_address: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  user_id?: string;
  notes?: string;
  tags?: string;
  created_at: string;
  updated_at?: string;
  metadata_key?: string;
  metadata_value?: string;
  webhook_delivery_status?: string;
  webhook_delivered_at?: string;
}

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
  webhook_delivered_at: "2026-03-27T11:46:05.000Z",
};

function verifyWebhookSignature(payload: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expectedSignature = signature.substring(7);
  const computedSignature = createHmac("sha256", secret).update(payload).digest("hex");
  if (expectedSignature.length !== computedSignature.length) return false;
  return timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(computedSignature));
}

/** GET /webhooks/settings - returns current compression toggle state */
router.get("/settings", (req: Request, res: Response) => {
  res.json({
    compression: webhookSettings.compression,
    description: {
      compression: "When enabled, outgoing webhook payloads are Gzip-compressed (Content-Encoding: gzip). Reduces egress bandwidth for large payloads.",
    },
  });
});

/** PATCH /webhooks/settings - toggle compression on/off. Body: { "compression": true | false } */
router.patch("/settings", (req: Request, res: Response) => {
  const { compression } = req.body as { compression?: unknown };
  if (compression === undefined) {
    return res.status(400).json({ error: "Missing field: compression (boolean)" });
  }
  if (typeof compression !== "boolean") {
    return res.status(400).json({ error: "Invalid value for 'compression': must be a boolean" });
  }
  webhookSettings.compression = compression;
  console.log(`[webhook-settings] compression set to ${compression}`);
  return res.json({ updated: true, settings: { compression: webhookSettings.compression } });
});

router.get("/schema", (req: Request, res: Response) => {
  res.json({
    name: "Mobile Money Webhooks",
    description: "Flat webhook payloads optimized for no-code automation platforms",
    version: "1.0.0",
    events: ["transaction.completed", "transaction.failed", "transaction.pending", "transaction.cancelled"],
    sample_payload: SAMPLE_WEBHOOK_PAYLOAD,
    settings: { compression: webhookSettings.compression },
    schema: {
      type: "object",
      properties: {
        event_id: { type: "string" }, event_type: { type: "string" }, timestamp: { type: "string", format: "date-time" },
        transaction_id: { type: "string" }, reference_number: { type: "string" },
        transaction_type: { type: "string", enum: ["deposit", "withdraw"] },
        amount: { type: "string" }, currency: { type: "string" }, phone_number: { type: "string" },
        provider: { type: "string" }, stellar_address: { type: "string" },
        status: { type: "string", enum: ["pending", "completed", "failed", "cancelled"] },
        user_id: { type: "string" }, notes: { type: "string" }, tags: { type: "string" },
        created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" },
        metadata_key: { type: "string" }, metadata_value: { type: "string" },
        webhook_delivery_status: { type: "string" }, webhook_delivered_at: { type: "string", format: "date-time" },
      },
    },
    setup_instructions: {
      zapier: { webhook_url: `${req.protocol}://${req.get("host")}/api/webhooks`, authentication: "X-Webhook-Signature header with HMAC-SHA256" },
      make_com: { webhook_url: `${req.protocol}://${req.get("host")}/api/webhooks`, authentication: "X-Webhook-Signature header with HMAC-SHA256" },
    },
  });
});

router.get("/sample", (req: Request, res: Response) => res.json(SAMPLE_WEBHOOK_PAYLOAD));

router.post("/", async (req: Request, res: Response) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error("[webhook] WEBHOOK_SECRET not configured");
    return res.status(500).json({ error: "Webhook processing not configured" });
  }
  const signature = req.headers["x-webhook-signature"] as string | undefined;
  const rawPayload = JSON.stringify(req.body);
  if (!verifyWebhookSignature(rawPayload, signature, webhookSecret)) {
    console.warn("[webhook] Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }
  try {
    const payload = req.body as FlatWebhookPayload;
    if (!payload.transaction_id || !payload.event_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const transaction = await transactionModel.findById(payload.transaction_id);
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found", transaction_id: payload.transaction_id });
    }
    if (payload.status && payload.status !== transaction.status) {
      await transactionModel.updateStatus(transaction.id, payload.status as TransactionStatus);
      console.log(`[webhook] Updated transaction ${transaction.id} to ${payload.status}`);
    }
    console.log(`[webhook] Processed event ${payload.event_id} for transaction ${payload.transaction_id}`);
    return res.status(200).json({ success: true, event_id: payload.event_id, transaction_id: payload.transaction_id, processed_at: new Date().toISOString() });
  } catch (error) {
    logger.error("[webhook] Processing error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/test", (req: Request, res: Response) => {
  console.log("[webhook-test] Received payload:", req.body);
  res.json({
    received: true,
    timestamp: new Date().toISOString(),
    payload: req.body,
    headers: {
      "content-type": req.get("content-type"),
      "x-webhook-signature": req.get("x-webhook-signature"),
      "content-encoding": req.get("content-encoding"),
      "user-agent": req.get("user-agent"),
    },
  });
});

export { webhookSettings };
export default router;
