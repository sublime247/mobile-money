import { Router, Request, Response } from "express";
import { verifyWebhookSignature } from "../middleware/verifySignature";
import { WebhookEvent, PaymentData } from "../types/webhook";
import logger from "../logger";

const router = Router();

router.post(
  "/webhook",
  verifyWebhookSignature,
  (req: Request, res: Response) => {
    const event = req.body as WebhookEvent<PaymentData>;

    logger.info(
      { eventType: event.type },
      "Webhook received",
    );

    switch (event.type) {
      case "payment.success":
        logger.info(
          {
            eventType: event.type,
            paymentId: event.data?.id,
            amount: event.data?.amount,
            status: event.data?.status,
          },
          "Payment succeeded",
        );
        break;

      case "payment.failed":
        logger.warn(
          {
            eventType: event.type,
            paymentId: event.data?.id,
            amount: event.data?.amount,
            status: event.data?.status,
          },
          "Payment failed",
        );
        break;

      default:
        logger.warn(
          { eventType: event.type },
          "Unhandled webhook event type",
        );
    }

    res.status(200).json({ received: true });
  },
);

export default router;
