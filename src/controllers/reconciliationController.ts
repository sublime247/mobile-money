import { Request, Response } from "express";
import { ProviderReconService } from "../services/providerReconService";
import { ReconciliationModel } from "../models/reconciliation";
import logger from "../utils/logger";
import { z } from "zod";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const ManualReconSchema = z.object({
  provider: z.string().min(1),
  date: z.string().optional(), // ISO date string
});

export class ReconciliationController {
  private reconService: ProviderReconService;
  private reconModel: ReconciliationModel;

  constructor() {
    this.reconService = new ProviderReconService();
    this.reconModel = new ReconciliationModel();
  }

  /**
   * Manually upload a CSV and run reconciliation
   * POST /api/reconciliation/upload
   */
  uploadAndReconcile = async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        throw createError(ERROR_CODES.INVALID_INPUT, "No file uploaded", {
          error: "No file uploaded",
        });
      }

      const { provider, date } = ManualReconSchema.parse(req.body);
      const reportDate = date ? new Date(date) : new Date();

      const reportId = await this.reconService.runReconciliation(
        provider,
        reportDate,
        req.file.buffer,
        req.file.originalname,
      );

      res.status(201).json({
        success: true,
        data: { reportId },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.issues,
        });
      }
      logger.error(error, "Manual reconciliation upload failed");
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to run reconciliation",
      );
    }
  };

  /**
   * List reconciliation reports
   * GET /api/reconciliation/reports
   */
  getReports = async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const offset = parseInt(req.query.offset as string) || 0;

      const reports = await this.reconModel.getReports(limit, offset);
      res.json({ success: true, data: reports });
    } catch (error) {
      logger.error(error, "Failed to fetch reports");
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch reconciliation reports",
      );
    }
  };

  /**
   * Get report details and its discrepancies
   * GET /api/reconciliation/reports/:id
   */
  getReportDetails = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const report = await this.reconModel.getReportById(id);

      if (!report) {
        throw createError(ERROR_CODES.NOT_FOUND, "Report not found", {
          error: "Report not found",
        });
      }

      const discrepancies =
        await this.reconModel.getDiscrepanciesByReportId(id);

      res.json({
        success: true,
        data: {
          report,
          discrepancies,
        },
      });
    } catch (error) {
      logger.error(error, "Failed to fetch report details");
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch report details",
      );
    }
  };

  /**
   * Resolve a discrepancy
   * PATCH /api/reconciliation/discrepancies/:id/resolve
   */
  resolveDiscrepancy = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;

      if (!notes) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "Resolution notes are required",
          {
            error: "Resolution notes are required",
          },
        );
      }

      await this.reconModel.resolveDiscrepancy(id, notes);
      res.json({ success: true, message: "Discrepancy marked as resolved" });
    } catch (error) {
      logger.error(error, "Failed to resolve discrepancy");
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to resolve discrepancy",
      );
    }
  };
}
