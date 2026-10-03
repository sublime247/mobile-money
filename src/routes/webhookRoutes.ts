import { Router, Request, Response } from "express";
import { z } from "zod";
import { validateWebhookSignature } from "../middleware/validateWebhookSignature";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";
import { validateRequest } from "../middleware/validation";
import { validateSourceIp } from "../middleware/validateSourceIp";
import { idempotency } from "../middleware/idempotency";
import logger from "../utils/logger";

const router = Router();

router.use(ingestRateLimiter);

const orangeCallbackSchema = z.object({
  reference: z.string().min(1),
  status: z.enum(["SUCCESSFUL", "FAILED", "PENDING", "IN_PROGRESS"]),
  transactionId: z.string().optional(),
  amount: z.string().or(z.number()).optional(),
  currency: z.string().optional(),
  msisdn: z.string().optional(),
  failureReason: z.string().optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
});

const orangeBatchCallbackSchema = z.object({
  batchId: z.string().min(1),
  items: z.array(
    z.object({
      referenceId: z.string().min(1),
      status: z.enum(["SUCCESSFUL", "FAILED", "PENDING"]),
      transactionId: z.string().optional(),
      errorReason: z.string().optional(),
    }),
  ),
});

// MTN webhook
router.post(
  "/mtn/callback",
  idempotency,
  validateSourceIp("mtn"),
  validateWebhookSignature("mtn"),
  async (req: Request, res: Response) => {
    const transactionId = req.body?.transactionId;
    const traceId =
      (req.headers["x-trace-id"] as string) ||
      (req.headers["x-request-id"] as string);

    const log = logger.child({
      ...(transactionId && { transactionId }),
      ...(traceId && { trace_id: traceId }),
    });

    try {
      log.info({ event: "mtn.callback.received" }, "MTN callback received");
      res.status(200).json({ status: "accepted" });
      log.info(
        { event: "mtn.callback.acknowledged" },
        "MTN callback acknowledged",
      );
    } catch (error: any) {
      log.error(
        { event: "mtn.callback.error", error: error.message },
        "MTN callback processing failed",
      );
      res.status(500).json({ status: "error", message: "Internal server error" });
    }
  },
);

// Orange webhook
router.post(
  "/orange/callback",
  validateSourceIp("orange"),
  validateWebhookSignature("orange"),
  validateRequest(orangeCallbackSchema),
  async (req: Request, res: Response) => {
    logger.info(
      {
        reference: req.body.reference,
        status: req.body.status,
        transactionId: req.body.transactionId,
      },
      "Orange: Callback received",
    );
    res.status(200).json({ status: "accepted" });
  },
);

router.post(
  "/orange/callback/batch",
  validateSourceIp("orange"),
  validateWebhookSignature("orange"),
  validateRequest(orangeBatchCallbackSchema),
  async (req: Request, res: Response) => {
    logger.info(
      {
        batchId: req.body.batchId,
        itemCount: req.body.items.length,
      },
      "Orange: Batch callback received",
    );
    res.status(200).json({ status: "accepted" });
  },
);

// Airtel webhook
router.post(
  "/airtel/callback",
  idempotency,
  validateSourceIp("airtel"),
  validateWebhookSignature("airtel"),
  async (req: Request, res: Response) => {
    logger.info(
      {
        transactionId: req.body.transaction_id,
        event: req.body.event_type,
      },
      "Airtel: Webhook received",
    );
    res.status(200).json({ status: "accepted" });
  },
);

export default router;
