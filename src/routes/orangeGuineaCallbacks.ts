import { Router, Request, Response } from "express";
import { z } from "zod";
import { verifyOrangeGuineaCallbackSignature } from "../middleware/orangeGuineaCallbackSignature";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";
import { validateRequest } from "../middleware/validation";
import {
  parseOrangeCiXml,
  buildOrangeCiAckXml,
  ORANGE_CI_ACK_OK,
  ORANGE_CI_ACK_ERROR,
} from "../providers/orange/orangeCiXmlParser";
import logger from "../utils/logger";

const router = Router();

router.use(ingestRateLimiter);
router.use(verifyOrangeGuineaCallbackSignature);

const orangeGuineaCallbackSchema = z.object({
  reference: z.string().min(1),
  status: z.enum(["SUCCESSFUL", "FAILED", "PENDING", "IN_PROGRESS"]),
  transactionId: z.string().optional(),
  amount: z.string().or(z.number()).optional(),
  currency: z.string().optional(),
  msisdn: z.string().optional(),
  failureReason: z.string().optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
});

const orangeGuineaBatchCallbackSchema = z.object({
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

router.post(
  "/callback",
  validateRequest(orangeGuineaCallbackSchema),
  async (req: Request, res: Response) => {
    logger.info(
      {
        reference: req.body.reference,
        status: req.body.status,
        transactionId: req.body.transactionId,
      },
      "OrangeGuinea: Callback received",
    );
    res.status(200).json({ status: "accepted" });
  },
);

router.post(
  "/callback/batch",
  validateRequest(orangeGuineaBatchCallbackSchema),
  async (req: Request, res: Response) => {
    logger.info(
      {
        batchId: req.body.batchId,
        itemCount: req.body.items.length,
      },
      "OrangeGuinea: Batch callback received",
    );
    res.status(200).json({ status: "accepted" });
  },
);

/**
 * POST /ci/xml/callback
 *
 * Accepts Orange Money Ivory Coast XML merchant collection notifications.
 * Content-Type: application/xml (or text/xml).
 *
 * Returns the XML acknowledgement payload expected by the Orange Money CI
 * gateway with Content-Type: application/xml.
 */
router.post("/ci/xml/callback", async (req: Request, res: Response) => {
  // The raw XML body is available via req.rawBody (captured by the global
  // body-parser verify hook) or via the string body when express is
  // configured with a text/xml parser.  We fall back to JSON.stringify as
  // a last resort so the route never crashes on unexpected content types.
  const rawBody: string =
    typeof req.body === "string"
      ? req.body
      : (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ??
        JSON.stringify(req.body ?? "");

  const parseResult = parseOrangeCiXml(rawBody);

  if (!parseResult.success) {
    const failureError = 'error' in parseResult ? parseResult.error : "Unknown parse error";
    logger.warn(
      { error: failureError, path: req.path },
      "OrangeCI: Failed to parse XML notification",
    );
    res
      .status(400)
      .set("Content-Type", "application/xml")
      .send(buildOrangeCiAckXml(ORANGE_CI_ACK_ERROR));
    return;
  }

  const notification = parseResult.data;

  logger.info(
    {
      transactionId: notification.transactionId,
      clientReference: notification.clientReference,
      status: notification.status,
      rawStatus: notification.rawStatus,
    },
    "OrangeCI: XML notification received",
  );

  res
    .status(200)
    .set("Content-Type", "application/xml")
    .send(buildOrangeCiAckXml(ORANGE_CI_ACK_OK));
});

export default router;
