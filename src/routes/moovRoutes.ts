import { Router, Request, Response } from "express";
import {
  getMoovBeninClient,
  MoovBeninClient,
} from "../providers/moov/moovBeninClient";

/**
 * Moov Africa routes (#2559).
 *
 *   POST /benin/collections                     — send a push USSD deposit prompt (XOF)
 *   GET  /benin/collections/:reference/status   — fallback status check for unconfirmed pushes
 *
 * The router factory accepts a client so tests (and alternative
 * configurations) can inject one; production uses the env-configured
 * singleton.
 */
export function createMoovRouter(
  client: Pick<MoovBeninClient, "initiatePush" | "checkStatus"> = getMoovBeninClient(),
): Router {
  const router = Router();

  router.post("/benin/collections", async (req: Request, res: Response) => {
    const { phoneNumber, amount, reference, description } = (req.body ?? {}) as {
      phoneNumber?: string;
      amount?: number | string;
      reference?: string;
      description?: string;
    };

    const numericAmount = Number(amount);
    if (!phoneNumber || typeof phoneNumber !== "string" || !Number.isFinite(numericAmount)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "phoneNumber and a numeric amount are required",
      });
    }

    const result = await client.initiatePush({
      phoneNumber,
      amount: numericAmount,
      reference,
      description,
    });

    if (result.accepted) {
      return res.status(202).json(result);
    }
    if (result.timedOut) {
      // Outcome unknown: the caller must poll the status endpoint.
      return res.status(202).json(result);
    }
    return res.status(result.retryable ? 502 : 422).json(result);
  });

  router.get(
    "/benin/collections/:reference/status",
    async (req: Request, res: Response) => {
      const { reference } = req.params;
      if (!reference) {
        return res.status(400).json({ error: "Bad Request", message: "reference is required" });
      }
      const status = await client.checkStatus(reference);
      return res.status(200).json(status);
    },
  );

  return router;
}

export default createMoovRouter;
