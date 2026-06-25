import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { getProvidersStatus } from "../services/providerStatusService";

const router = Router();

/**
 * GET /api/admin/providers/status
 *
 * Returns Green/Yellow/Red status for each mobile money provider
 * based on the last 100 recorded API calls.
 *
 * Green  : success rate >= 95%
 * Yellow : success rate >= 80%
 * Red    : success rate <  80% (or no data)
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const result = await getProvidersStatus();
    res.json(result);
  } catch (err) {
    logger.error("[provider-status] Failed to fetch provider status", err);
    res.status(500).json({ error: "Failed to fetch provider status" });
  }
});

export default router;
