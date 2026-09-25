import { Router, Request, Response } from "express";
import { z } from "zod";
import { verifyVodafoneGhanaCallbackSignature } from "../middleware/vodafoneGhanaCallbackSignature";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";
import { validateRequest } from "../middleware/validation";
import { VodafoneGhanaProvider } from "../services/mobilemoney/providers/vodafoneGhana";
import logger from "../utils/logger";

const router = Router();

router.use(ingestRateLimiter);
router.use(verifyVodafoneGhanaCallbackSignature);

const vodafoneGhanaCallbackSchema = z.object({
  transactionId: z.string().optional(),
  referenceId: z.string().optional(),
  status: z.string().min(1),
  amount: z.string().or(z.number()).optional(),
  currency: z.string().optional(),
  msisdn: z.string().optional(),
  voucherCode: z.string().optional(),
  failureReason: z.string().optional(),
});

router.post(
  "/callback",
  validateRequest(vodafoneGhanaCallbackSchema),
  async (req: Request, res: Response) => {
    const parsed = VodafoneGhanaProvider.parseCallback(req.body);

    logger.info(
      {
        transactionId: parsed.transactionId,
        status: parsed.status,
        voucherCode: parsed.voucherCode,
      },
      "VodafoneGhana: Callback received",
    );

    res.status(200).json({ status: "accepted" });
  },
);

export default router;
