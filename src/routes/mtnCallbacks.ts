import { Router, Request, Response } from "express";
import { verifyMtnCallbackSignature } from "../middleware/mtnCallbackSignature";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";
import logger from "../utils/logger";

const router = Router();

router.use(ingestRateLimiter);
router.use(verifyMtnCallbackSignature);

router.post("/callback", async (req: Request, res: Response) => {
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

    log.info({ event: "mtn.callback.acknowledged" }, "MTN callback acknowledged");
  } catch (error: any) {
    log.error(
      { event: "mtn.callback.error", error: error.message },
      "MTN callback processing failed",
    );
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

export default router;
