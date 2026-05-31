import { Router, Request, Response } from "express";
import { verifySignature } from "../middleware/verifySignature";
import { WebhookEvent, PaymentData } from "../types/webhook";

const router = Router();

router.post("/webhook", verifySignature, (req: Request, res: Response) => {
  const event = req.body as WebhookEvent<PaymentData>;

  console.log("Received webhook:", event);

  switch (event.type) {
    case "payment.success":
      console.log("Payment successful:", event.data);
      break;

    case "payment.failed":
      console.log("Payment failed:", event.data);
      break;

    default:
      console.log("Unhandled event:", event.type);
  }

  res.status(200).json({ received: true });
});

export default router;
