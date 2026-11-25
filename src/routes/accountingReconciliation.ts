import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { accountingReconciliationController } from "../controllers/accountingReconciliationController";
import { runDailyReconciliation } from "../services/accounting/ledgerReconciler";
import logger from "../utils/logger";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Middleware to ensure user is authenticated
// router.use(requireAuth);

// Run daily chart of accounts reconciliation
router.post(
  "/reconcile",
  // validateRequest(DailyReconcileSchema), // Would need to import the schema
  accountingReconciliationController.reconcile,
);

// List accounting reconciliation reports
router.get("/reports", accountingReconciliationController.getReports);

// Get accounting reconciliation report details and its discrepancies
router.get("/reports/:id", accountingReconciliationController.getReportDetails);

// Export accounting reconciliation report to CSV
router.get(
  "/reports/:id/export",
  accountingReconciliationController.exportReport,
);

// Resolve a discrepancy
router.patch(
  "/discrepancies/:id/resolve",
  accountingReconciliationController.resolveDiscrepancy,
);

// Get reports for a specific connection
router.get(
  "/connections/:connectionId/reports",
  accountingReconciliationController.getReportsByConnection,
);

/**
 * POST /ledger/reconcile
 *
 * Run daily ledger-vs-on-chain reconciliation and return a structured report.
 *
 * Body:
 *   {
 *     date: "YYYY-MM-DD",                       // defaults to yesterday
 *     providers: { "<name>": "<issuerAddress>" } // required
 *   }
 */
router.post(
  "/ledger/reconcile",
  async (req: Request, res: Response) => {
    try {
      const rawDate: string | undefined = req.body?.date;
      const issuerAddressByProvider: Record<string, string> | undefined =
        req.body?.providers;

      if (
        !issuerAddressByProvider ||
        typeof issuerAddressByProvider !== "object" ||
        Object.keys(issuerAddressByProvider).length === 0
      ) {
        res.status(400).json({
          error: "providers field is required and must map provider names to issuer addresses",
        });
        return;
      }

      let date: Date;
      if (rawDate) {
        date = new Date(rawDate);
        if (isNaN(date.getTime())) {
          res.status(400).json({ error: "Invalid date format; expected YYYY-MM-DD" });
          return;
        }
      } else {
        // Default to yesterday
        date = new Date();
        date.setUTCDate(date.getUTCDate() - 1);
      }

      const report = await runDailyReconciliation(date, { issuerAddressByProvider });

      res.status(200).json(report);
    } catch (error) {
      logger.error({ error }, "[accounting-reconciliation] Ledger reconciliation failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
