/**
 * Merchant Webhook Management — self-serve CRUD + test + delivery history.
 *
 * All routes require a valid JWT (requireAuth). Merchants can only manage
 * their own webhooks; the userId is always sourced from req.jwtUser.
 *
 * Routes:
 *   GET    /api/merchant/webhooks                        — list webhooks
 *   POST   /api/merchant/webhooks                        — create webhook
 *   GET    /api/merchant/webhooks/:id                    — get single webhook
 *   PATCH  /api/merchant/webhooks/:id                    — update webhook
 *   DELETE /api/merchant/webhooks/:id                    — delete webhook
 *   POST   /api/merchant/webhooks/:id/test               — send test delivery
 *   GET    /api/merchant/webhooks/:id/deliveries         — delivery history
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { MerchantWebhookModel, CreateWebhookInput, UpdateWebhookInput } from "../models/merchantWebhook";
import { MerchantWebhookService } from "../services/merchantWebhookService";

const router = Router();
const webhookModel = new MerchantWebhookModel();
const webhookService = new MerchantWebhookService();

// All routes require authentication
router.use(requireAuth);

// ── Helpers ────────────────────────────────────────────────────────────────

function getUserId(req: Request): string | null {
  return req.jwtUser?.userId ?? null;
}

const URL_REGEX = /^https?:\/\/.+/i;

function validateCreateBody(body: unknown): { data: CreateWebhookInput; error?: never } | { error: string; data?: never } {
  if (!body || typeof body !== "object") return { error: "Request body required" };
  const b = body as Record<string, unknown>;

  if (typeof b.url !== "string" || !URL_REGEX.test(b.url)) {
    return { error: "url must be a valid HTTP/HTTPS URL" };
  }
  if (typeof b.secret !== "string" || b.secret.length < 16) {
    return { error: "secret must be a string of at least 16 characters" };
  }
  if (b.events !== undefined) {
    if (!Array.isArray(b.events) || b.events.some((e) => typeof e !== "string")) {
      return { error: "events must be an array of strings" };
    }
  }
  if (b.description !== undefined && typeof b.description !== "string") {
    return { error: "description must be a string" };
  }

  return {
    data: {
      userId: "", // filled in by route handler
      url: b.url,
      secret: b.secret,
      description: typeof b.description === "string" ? b.description : undefined,
      events: Array.isArray(b.events) ? (b.events as string[]) : undefined,
    },
  };
}

// ── List ───────────────────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const webhooks = await webhookModel.findByUserId(userId);
    // Never expose the raw secret in list responses
    const safe = webhooks.map(({ secret: _s, ...w }) => w);
    return res.json({ webhooks: safe, total: safe.length });
  } catch (err) {
    console.error("[merchant-webhooks] list error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── Create ─────────────────────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const validation = validateCreateBody(req.body);
  if (validation.error) return res.status(400).json({ error: validation.error });

  try {
    const webhook = await webhookModel.create({ ...validation.data!, userId });
    const { secret: _s, ...safe } = webhook;
    return res.status(201).json({ webhook: safe });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    const status = msg.startsWith("Maximum") || msg.startsWith("Unknown event") ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
});

// ── Get single ─────────────────────────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const webhook = await webhookModel.findById(req.params.id, userId);
    if (!webhook) return res.status(404).json({ error: "Webhook not found" });
    const { secret: _s, ...safe } = webhook;
    return res.json({ webhook: safe });
  } catch (err) {
    console.error("[merchant-webhooks] get error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── Update ─────────────────────────────────────────────────────────────────

router.patch("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const b = req.body as Record<string, unknown>;
  const input: UpdateWebhookInput = {};

  if (b.url !== undefined) {
    if (typeof b.url !== "string" || !URL_REGEX.test(b.url)) {
      return res.status(400).json({ error: "url must be a valid HTTP/HTTPS URL" });
    }
    input.url = b.url;
  }
  if (b.secret !== undefined) {
    if (typeof b.secret !== "string" || b.secret.length < 16) {
      return res.status(400).json({ error: "secret must be at least 16 characters" });
    }
    input.secret = b.secret;
  }
  if (b.description !== undefined) {
    if (typeof b.description !== "string") return res.status(400).json({ error: "description must be a string" });
    input.description = b.description;
  }
  if (b.events !== undefined) {
    if (!Array.isArray(b.events)) return res.status(400).json({ error: "events must be an array" });
    input.events = b.events as string[];
  }
  if (b.is_active !== undefined) {
    if (typeof b.is_active !== "boolean") return res.status(400).json({ error: "is_active must be a boolean" });
    input.isActive = b.is_active;
  }

  try {
    const webhook = await webhookModel.update(req.params.id, userId, input);
    if (!webhook) return res.status(404).json({ error: "Webhook not found" });
    const { secret: _s, ...safe } = webhook;
    return res.json({ webhook: safe });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    const status = msg.startsWith("Unknown event") ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
});

// ── Delete ─────────────────────────────────────────────────────────────────

router.delete("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const deleted = await webhookModel.delete(req.params.id, userId);
    if (!deleted) return res.status(404).json({ error: "Webhook not found" });
    return res.json({ deleted: true });
  } catch (err) {
    console.error("[merchant-webhooks] delete error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── Test delivery ──────────────────────────────────────────────────────────

router.post("/:id/test", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { log, webhook } = await webhookService.testWebhook(req.params.id, userId);
    return res.json({
      success: log.status === "delivered",
      delivery: {
        id: log.id,
        status: log.status,
        http_status: log.httpStatus,
        duration_ms: log.durationMs,
        error_message: log.errorMessage,
        created_at: log.createdAt,
      },
      webhook_url: webhook.url,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    const status = msg === "Webhook not found" ? 404 : 500;
    return res.status(status).json({ error: msg });
  }
});

// ── Delivery history ───────────────────────────────────────────────────────

router.get("/:id/deliveries", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 100);
  const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

  try {
    const { logs, total } = await webhookModel.getDeliveryLogs(
      req.params.id,
      userId,
      limit,
      offset,
    );
    return res.json({ deliveries: logs, total, limit, offset });
  } catch (err) {
    console.error("[merchant-webhooks] delivery history error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
