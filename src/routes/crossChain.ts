import { Router, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { CrossChainMonitorService } from "../services/crossChainMonitorService";

const router = Router();

router.get("/balances", requireAuth, (_req: AuthRequest, res: Response) => {
  const snapshots = CrossChainMonitorService.getInstance().getLastSnapshot();
  res.json(snapshots);
});

export default router;
