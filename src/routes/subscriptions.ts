import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { authenticateToken } from "../middleware/auth";
import subscriptionModel from "../models/subscription";
import { encrypt } from "../utils/encryption";
import { notificationRouter } from "../services/notificationRouter";
import { z } from "zod";

export const subscriptionsRoutes = Router();

// Create subscription
subscriptionsRoutes.post("/", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.jwtUser as any;
    if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
    const createSchema = z.object({
      user_id: z.string().optional().nullable(),
      phone_number: z.string().optional().nullable(),
      amount: z.union([z.string(), z.number()]),
      currency: z.string().optional().default("USD"),
      interval: z.enum(["daily", "weekly", "monthly"]),
      next_run_at: z.string().optional(),
      metadata: z.any().optional(),
      max_retries: z.number().int().min(0).optional(),
      retry_backoff_seconds: z.number().int().min(0).optional(),
    });

    const parsed = createSchema.parse(req.body);
    const encPhone = parsed.phone_number ? encrypt(parsed.phone_number) : null;

    const created = await subscriptionModel.create({
      merchant_id: user.userId,
      user_id: parsed.user_id ?? null,
      phone_number: encPhone,
      amount: parsed.amount,
      currency: parsed.currency,
      interval: parsed.interval,
      next_run_at: parsed.next_run_at ?? null,
      metadata: parsed.metadata ?? {},
      max_retries: parsed.max_retries ?? 3,
      retry_backoff_seconds: parsed.retry_backoff_seconds ?? 600,
    });

    // Notify merchant of creation (low severity)
    await notificationRouter.routeSystemNotification("low", "subscription", "Subscription Created", `Subscription ${created.id} created` , { subscriptionId: created.id });

    res.status(201).json({ subscription: created });
  } catch (err) {
    logger.error("Failed to create subscription", err);
    res.status(500).json({ error: "Failed to create subscription" });
  }
});

// List merchant subscriptions
subscriptionsRoutes.get("/", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.jwtUser as any;
    if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
    const rows = await subscriptionModel.listByMerchant(user.userId);
    res.json({ subscriptions: rows });
  } catch (err) {
    logger.error("Failed to list subscriptions", err);
    res.status(500).json({ error: "Failed to list subscriptions" });
  }
});

// Get subscription
subscriptionsRoutes.get("/:id", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.jwtUser as any;
    if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
    const sub = await subscriptionModel.getById(req.params.id);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    if (sub.merchant_id !== user.userId) return res.status(403).json({ error: "Forbidden" });
    res.json({ subscription: sub });
  } catch (err) {
    logger.error("Failed to get subscription", err);
    res.status(500).json({ error: "Failed to get subscription" });
  }
});

// Update subscription (pause/resume/cancel or fields)
subscriptionsRoutes.patch("/:id", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.jwtUser as any;
    if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
    const sub = await subscriptionModel.getById(req.params.id);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    if (sub.merchant_id !== user.userId) return res.status(403).json({ error: "Forbidden" });
    const updateSchema = z.object({
      phone_number: z.string().optional().nullable(),
      amount: z.union([z.string(), z.number()]).optional(),
      currency: z.string().optional(),
      interval: z.enum(["daily", "weekly", "monthly"]).optional(),
      next_run_at: z.string().optional().nullable(),
      metadata: z.any().optional(),
      max_retries: z.number().int().min(0).optional(),
      retry_backoff_seconds: z.number().int().min(0).optional(),
      status: z.string().optional(),
    }).partial();

    const parsed = updateSchema.parse(req.body || {});
    if (parsed.phone_number) parsed.phone_number = encrypt(parsed.phone_number);
    const updated = await subscriptionModel.update(req.params.id, parsed as any);

    res.json({ subscription: updated });
  } catch (err) {
    logger.error("Failed to update subscription", err);
    res.status(500).json({ error: "Failed to update subscription" });
  }
});

// Delete (cancel) subscription
subscriptionsRoutes.delete("/:id", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.jwtUser as any;
    if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
    const sub = await subscriptionModel.getById(req.params.id);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    if (sub.merchant_id !== user.userId) return res.status(403).json({ error: "Forbidden" });
    await subscriptionModel.delete(req.params.id);
    res.status(204).end();
  } catch (err) {
    logger.error("Failed to delete subscription", err);
    res.status(500).json({ error: "Failed to delete subscription" });
  }
});

// Pause subscription
subscriptionsRoutes.post("/:id/pause", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.jwtUser as any;
    if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
    const sub = await subscriptionModel.getById(req.params.id);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    if (sub.merchant_id !== user.userId) return res.status(403).json({ error: "Forbidden" });
    await subscriptionModel.pause(req.params.id);
    await notificationRouter.routeSystemNotification("medium", "subscription", "Subscription Paused", `Subscription ${req.params.id} was paused by merchant`, { subscriptionId: req.params.id });
    res.status(200).json({ paused: true });
  } catch (err) {
    logger.error("Failed to pause subscription", err);
    res.status(500).json({ error: "Failed to pause subscription" });
  }
});

// Resume subscription
subscriptionsRoutes.post("/:id/resume", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.jwtUser as any;
    if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
    const sub = await subscriptionModel.getById(req.params.id);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    if (sub.merchant_id !== user.userId) return res.status(403).json({ error: "Forbidden" });
    await subscriptionModel.resume(req.params.id);
    await notificationRouter.routeSystemNotification("low", "subscription", "Subscription Resumed", `Subscription ${req.params.id} was resumed by merchant`, { subscriptionId: req.params.id });
    const refreshed = await subscriptionModel.getById(req.params.id);
    res.json({ subscription: refreshed });
  } catch (err) {
    logger.error("Failed to resume subscription", err);
    res.status(500).json({ error: "Failed to resume subscription" });
  }
});

export default subscriptionsRoutes;
