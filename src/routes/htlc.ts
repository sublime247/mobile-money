import { Router, Request, Response } from "express";
import { HtlcService } from "../services/stellar/htlcService";
import { z } from "zod";

const router = Router();
const htlcService = new HtlcService();

const lockSchema = z.object({
  senderAddress: z.string(),
  receiverAddress: z.string(),
  tokenAddress: z.string(),
  amount: z.string(),
  hashlock: z.string().length(64), // hex string
  timelock: z.number(),
  contractId: z.string(),
});

const claimSchema = z.object({
  claimerAddress: z.string(),
  preimage: z.string().length(64), // hex string
  contractId: z.string(),
});

const refundSchema = z.object({
  refunderAddress: z.string(),
  contractId: z.string(),
});

/**
 * Build lock transaction
 */
router.post("/lock", async (req: Request, res: Response) => {
  try {
    const params = lockSchema.parse(req.body);
    const tx = await htlcService.buildLockTx(params);

    res.json({
      xdr: tx.toEnvelope().toXDR("base64"),
      hash: tx.hash().toString("hex"),
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Build claim transaction
 */
router.post("/claim", async (req: Request, res: Response) => {
  try {
    const params = claimSchema.parse(req.body);
    const tx = await htlcService.buildClaimTx(params);

    res.json({
      xdr: tx.toEnvelope().toXDR("base64"),
      hash: tx.hash().toString("hex"),
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Build refund transaction
 */
router.post("/refund", async (req: Request, res: Response) => {
  try {
    const params = refundSchema.parse(req.body);
    const tx = await htlcService.buildRefundTx(params);

    res.json({
      xdr: tx.toEnvelope().toXDR("base64"),
      hash: tx.hash().toString("hex"),
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Get HTLC state
 */
router.get("/:contractId", async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
    const state = await htlcService.getHtlcState(contractId);
    res.json(state);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
