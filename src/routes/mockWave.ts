import { Router, Request, Response } from "express";
import { WaveSimulator } from "../services/mock/waveSimulator";
import logger from "../utils/logger";

const router = Router();
const simulator = new WaveSimulator();

router.post("/checkout/sessions", (req: Request, res: Response) => {
  try {
    const {
      amount,
      currency,
      client_reference,
      trigger_status,
      trigger_delay_ms,
    } = req.body;

    if (!amount || !currency || !client_reference) {
      return res
        .status(400)
        .json({ error: "Missing required checkout parameters" });
    }

    const session = simulator.createCheckoutSession(
      String(amount),
      currency,
      client_reference,
    );

    // Default to 'succeeded' if not provided, allowing test cases to override
    const status = trigger_status || "succeeded";
    // Default to a small delay (e.g., 100ms) to simulate real network delay
    const delay = typeof trigger_delay_ms === "number" ? trigger_delay_ms : 100;

    // Dispatch webhook asynchronously. The checkout session id is stable per
    // session so duplicate deliveries share one webhook idempotency key.
    simulator
      .dispatchWebhook(
        session.id,
        client_reference,
        status,
        String(amount),
        currency,
        delay,
      )
      .catch((err) => {
        logger.error(
          { error: err },
          "[MockWaveRoute] Failed to dispatch webhook in background",
        );
      });

    return res.status(200).json(session);
  } catch (error) {
    logger.error({ error }, "[MockWaveRoute] Error handling checkout creation");
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
