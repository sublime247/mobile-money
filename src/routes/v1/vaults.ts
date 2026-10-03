import { Router } from "express";
import { authenticateToken } from "../../middleware/auth";
import { idempotency } from "../../middleware/idempotency";
import {
  createVault,
  getUserVaults,
  getVaultById,
  updateVault,
  deleteVault,
  transferFunds,
  getVaultTransactions,
  getUserBalanceSummary,
} from "../../controllers/vaultController";

const router = Router();

// Apply authentication to all vault routes
router.use(authenticateToken);

// Vault management routes
router.post("/", createVault);
router.get("/", getUserVaults);
router.get("/balance-summary", getUserBalanceSummary);
router.get("/:vaultId", getVaultById);
router.put("/:vaultId", updateVault);
router.delete("/:vaultId", deleteVault);

// Vault transaction routes
router.post("/:vaultId/transfer", idempotency, transferFunds);
router.get("/:vaultId/transactions", getVaultTransactions);

export { router as vaultRoutesV1 };
