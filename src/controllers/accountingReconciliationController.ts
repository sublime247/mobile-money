import { Request, Response, NextFunction } from "express";
import { 
  AccountingChartOfAccountsReconciliationService
} from "../services/accountingReconciliation/service";
import { 
  AccountingChartOfAccountsReconciliationReport,
  AccountingChartOfAccountsReconciliationDiscrepancy,
  AccountingReconciliationStatus,
  AccountingDiscrepancyType,
  AccountingReviewStatus
} from "../services/accountingReconciliation/model";
import { logger } from "../services/logger";
import { z } from "zod";
import { AccountingService, AccountingProvider } from "../services/accounting";

const DailyReconcileSchema = z.object({
  provider: z.enum(["quickbooks", "xero"]),
  connectionId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD format
});

export class AccountingReconciliationController {
  private reconService: AccountingChartOfAccountsReconciliationService;
  private accountingService: AccountingService;

  constructor() {
    this.reconService = new AccountingChartOfAccountsReconciliationService();
    this.accountingService = new AccountingService();
  }

  /**
   * Run daily chart of accounts reconciliation
   * POST /api/accounting-reconciliation/reconcile
   */
  reconcile = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { provider, connectionId, date } = DailyReconcileSchema.parse(req.body);
      const reportDate = date ? new Date(date) : new Date();
      
      // Verify connection exists and belongs to user
      const connection = await this.accountingService.getConnection(connectionId);
      if (!connection) {
        return res.status(404).json({ error: "Connection not found" });
      }
      
      // TODO: Add user authentication check here
      // const userId = (req as any).user.id;
      // if (connection.userId !== userId) {
      //   return res.status(403).json({ error: "Unauthorized" });
      // }

      const reportId = await this.reconService.runDailyReconciliation(
        provider as AccountingProvider,
        connectionId,
        reportDate
      );

      res.status(201).json({
        success: true,
        data: { reportId },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation error", details: error.issues });
      }
      logger.error("Failed to run accounting reconciliation:", error);
      next(error);
    }
  };

  /**
   * List accounting reconciliation reports
   * GET /api/accounting-reconciliation/reports
   */
  getReports = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const offset = parseInt(req.query.offset as string) || 0;
      
      // TODO: Add user authentication and filtering by user's connections
      
      const reports = await this.reconService.getReports(limit, offset);
      res.json({ success: true, data: reports });
    } catch (error) {
      logger.error("Failed to fetch accounting reconciliation reports:", error);
      next(error);
    }
  };

  /**
   * Get accounting reconciliation report details and its discrepancies
   * GET /api/accounting-reconciliation/reports/:id
   */
  getReportDetails = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      
      const report = await this.reconService.getReportById(id);
      
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      
      // TODO: Add user authorization check
      
      const discrepancies = await this.reconService.getDiscrepanciesByReportId(id);
      
      res.json({
        success: true,
        data: {
          report,
          discrepancies,
        },
      });
    } catch (error) {
      logger.error("Failed to fetch accounting reconciliation report details:", error);
      next(error);
    }
  };

  /**
   * Resolve a discrepancy
   * PATCH /api/accounting-reconciliation/discrepancies/:id/resolve
   */
  resolveDiscrepancy = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;
      
      if (!notes) {
        return res.status(400).json({ error: "Resolution notes are required" });
      }
      
      // TODO: Add user authentication and authorization check
      // const userId = (req as any).user.id;
      
      await this.reconService.resolveDiscrepancy(id, notes, /* userId */ "temp-user-id");
      
      res.json({ success: true, message: "Discrepancy marked as resolved" });
    } catch (error) {
      logger.error("Failed to resolve discrepancy:", error);
      next(error);
    }
  };

  /**
   * Get reports for a specific connection
   * GET /api/accounting-reconciliation/connections/:connectionId/reports
   */
  getReportsByConnection = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connectionId } = req.params;
      const limit = parseInt(req.query.limit as string) || 10;
      const offset = parseInt(req.query.offset as string) || 0;
      
      // TODO: Add user authentication and authorization check
      
      const reports = await this.reconService.getReportsByConnection(connectionId, limit, offset);
      res.json({ success: true, data: reports });
    } catch (error) {
      logger.error("Failed to fetch accounting reconciliation reports by connection:", error);
      next(error);
    }
  };

  /**
   * Export reconciliation report to CSV
   * GET /api/accounting-reconciliation/reports/:id/export
   */
  exportReport = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      
      const report = await this.reconService.getReportById(id);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      
      // TODO: Add user authorization check
      
      const csv = await this.reconService.exportReportToCSV(id);
      
      const filename = `accounting_recon_${report.provider}_${new Date(report.reportDate).toISOString().split('T')[0]}.csv`;
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.status(200).send(csv);
    } catch (error) {
      logger.error("Failed to export accounting reconciliation report:", error);
      next(error);
    }
  };
}

export const accountingReconciliationController = new AccountingReconciliationController();
