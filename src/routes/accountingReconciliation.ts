import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { accountingReconciliationController } from "../controllers/accountingReconciliationController";
// import { requireAuth } from "../middleware/auth"; // Assuming there's auth middleware
// import { validateRequest } from "../middleware/validation"; // Assuming there's validation middleware

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Middleware to ensure user is authenticated
// router.use(requireAuth);

// Run daily chart of accounts reconciliation
router.post(
  "/reconcile",
  // validateRequest(DailyReconcileSchema), // Would need to import the schema
  accountingReconciliationController.reconcile
);

// List accounting reconciliation reports
router.get(
  "/reports",
  accountingReconciliationController.getReports
);

// Get accounting reconciliation report details and its discrepancies
router.get(
  "/reports/:id",
  accountingReconciliationController.getReportDetails
);

// Export accounting reconciliation report to CSV
router.get(
  "/reports/:id/export",
  accountingReconciliationController.exportReport
);

// Resolve a discrepancy
router.patch(
  "/discrepancies/:id/resolve",
  accountingReconciliationController.resolveDiscrepancy
);

// Get reports for a specific connection
router.get(
  "/connections/:connectionId/reports",
  accountingReconciliationController.getReportsByConnection
);

export default router;
