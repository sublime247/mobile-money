import { Router, Request, Response } from "express";
import { z } from "zod";
import { verifyOrangeMadagascarCallbackSignature } from "../middleware/orangeMadagascarCallbackSignature";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";
import { validateRequest } from "../middleware/validation";
import logger from "../utils/logger";

const router = Router();

router.use(ingestRateLimiter);
router.use(verifyOrangeMadagascarCallbackSignature);

const orangeMadagascarCallbackSchema = z.object({
  reference: z.string().min(1),
  status: z.enum(["SUCCESSFUL", "FAILED", "PENDING", "IN_PROGRESS"]),
  transactionId: z.string().optional(),
  amount: z.string().or(z.number()).optional(),
  currency: z.string().optional(),
  msisdn: z.string().optional(),
  failureReason: z.string().optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
});

const orangeMadagascarBatchCallbackSchema = z.object({
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

router.post("/callback", validateRequest(orangeMadagascarCallbackSchema), async (req: Request, res: Response) => {
  logger.info(
    {
      reference: req.body.reference,
      status: req.body.status,
      transactionId: req.body.transactionId,
    },
    "OrangeMadagascar: Callback received",
  );
  res.status(200).json({ status: "accepted" });
});

router.post(
  "/callback/batch",
  validateRequest(orangeMadagascarBatchCallbackSchema),
  async (req: Request, res: Response) => {
    logger.info(
      {
        batchId: req.body.batchId,
        itemCount: req.body.items.length,
      },
      "OrangeMadagascar: Batch callback received",
    );
    res.status(200).json({ status: "accepted" });
  },
);

export default router;
