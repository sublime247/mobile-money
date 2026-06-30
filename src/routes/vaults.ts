import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { attachUserObject } from "../middleware/attachUserObject";
import {
  createVault,
  getUserVaults,
  getVaultById,
  updateVault,
  deleteVault,
  transferFunds,
  getVaultTransactions,
  getUserBalanceSummary,
} from "../controllers/vaultController";

const router = Router();

// Apply authentication and user object attachment to all vault routes
router.use(authenticateToken);
router.use(attachUserObject);

// Vault management routes
router.post("/", createVault);
router.get("/", getUserVaults);
router.get("/balance-summary", getUserBalanceSummary);
router.get("/:vaultId", getVaultById);
router.put("/:vaultId", updateVault);
router.delete("/:vaultId", deleteVault);

// Vault transaction routes
router.post("/:vaultId/transfer", transferFunds);
router.get("/:vaultId/transactions", getVaultTransactions);

export { router as vaultRoutes };
