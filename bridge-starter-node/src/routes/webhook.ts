import { Router, Request, Response } from "express";
import { verifySignature } from "../middleware/verifySignature";
import { WebhookEvent, PaymentData } from "../types/webhook";
import { createChildLogger } from "../config/logger";

const logger = createChildLogger("webhook");
const router = Router();

router.post(
  "/webhook",
  verifySignature,
  (req: Request, res: Response) => {
    const event = req.body as WebhookEvent<PaymentData>;

    logger.info({ type: event.type }, "Received webhook");

    switch (event.type) {
      case "payment.success":
        logger.info({ paymentId: event.data }, "Payment successful");
        break;

      case "payment.failed":
        logger.warn({ paymentId: event.data }, "Payment failed");
        break;

      default:
        logger.warn({ type: event.type }, "Unhandled event type");
    }

    res.status(200).json({ received: true });
  }
);

export default router;
