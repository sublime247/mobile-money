import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import {
  createPaymentLinkHandler,
  renderPaymentLinkLandingHandler,
  processPaymentHandler,
  renderSuccessHandler,
  renderFailHandler,
} from "../controllers/paymentLinkController";

export const paymentLinkRoutes = Router();

// Secure endpoint for merchants to generate payment links
paymentLinkRoutes.post(
  "/api/payment-links",
  TimeoutPresets.quick,
  haltOnTimedout,
  authenticateToken,
  createPaymentLinkHandler,
);

// Public landing pages and payment handlers
paymentLinkRoutes.get(
  "/pay/:token",
  TimeoutPresets.quick,
  haltOnTimedout,
  renderPaymentLinkLandingHandler,
);

paymentLinkRoutes.post(
  "/pay/:token/process",
  TimeoutPresets.long,
  haltOnTimedout,
  processPaymentHandler,
);

paymentLinkRoutes.get(
  "/pay/result/success",
  TimeoutPresets.quick,
  haltOnTimedout,
  renderSuccessHandler,
);

paymentLinkRoutes.get(
  "/pay/result/fail",
  TimeoutPresets.quick,
  haltOnTimedout,
  renderFailHandler,
);
