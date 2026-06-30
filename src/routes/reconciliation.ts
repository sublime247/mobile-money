import { Router } from "express";
import multer from "multer";
import { ReconciliationController } from "../controllers/reconciliationController";
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

// Resolve discrepancy
router.patch("/discrepancies/:id/resolve", controller.resolveDiscrepancy);

export default router;
