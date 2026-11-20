import { Router } from "express";
import multer from "multer";
import { ReconciliationController } from "../controllers/reconciliationController";
import { requireAuth } from "../middleware/auth";
import { requireFinanceAccess } from "../middleware/requireFinanceAccess";
import {
  getBankStatementImportLines,
  listBankStatementImports,
  uploadBankStatement,
} from "../controllers/bankStatementController";
// import { authenticateAdmin } from "../middleware/auth"; // Assuming there's admin auth

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
const controller = new ReconciliationController();

// Manual upload
router.post(
  "/upload",
  // authenticateAdmin,
  upload.single("file"),
  controller.uploadAndReconcile,
);

// List reports
router.get("/reports", controller.getReports);

// Report details & discrepancies
router.get("/reports/:id", controller.getReportDetails);

// Bank statement (MT940 / CAMT.053) reconciliation of fiat deposits.
// Restricted to finance operators.
const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
router.post(
  "/bank-statements",
  requireAuth,
  requireFinanceAccess,
  statementUpload.single("file"),
  uploadBankStatement,
);
router.get(
  "/bank-statements",
  requireAuth,
  requireFinanceAccess,
  listBankStatementImports,
);
router.get(
  "/bank-statements/:id/lines",
  requireAuth,
  requireFinanceAccess,
  getBankStatementImportLines,
);

// Resolve discrepancy
router.patch("/discrepancies/:id/resolve", controller.resolveDiscrepancy);

export default router;
