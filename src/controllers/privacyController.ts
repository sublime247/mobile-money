import { Request, Response } from "express";
import { GDPRService } from "../services/gdprService";
import { logAuditEvent } from "../utils/log-audit-event";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const DATA_EXPORT_REQUIRED = "DATA_EXPORT_REQUIRED";
const RIGHT_TO_BE_FORGOTTEN_INITIATED = "RIGHT_TO_BE_FORGOTTEN_INITIATED";
const gdprService = new GDPRService();

const privacyController = {
  exportDataEndpoint: async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id || (req as any).userId;

      // keep for audit purpose
      await logAuditEvent(userId, DATA_EXPORT_REQUIRED);

      // exportUserData returns an in-memory ZIP buffer — no temp file on disk.
      const zipBuffer = await gdprService.exportUserData(userId);

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="gdpr-export-${userId}.zip"`,
      );
      res.setHeader("Content-Length", zipBuffer.length);
      res.send(zipBuffer);
    } catch (err) {
      console.error("Export error: ", err);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to export data.");
    }
  },
  rightToBeForgettenEndpoint: async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id || (req as any).userId;

      // Explicit confirmation from user via form field or api
      const { confirmed } = req.body;

      if (!confirmed) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Erasure must be confirmed", {
          error: "Erasure must be confirmed",
          message: "Send { confirmed: true } to proceed with data erasure",
        });
      }

      // Log the request
      await logAuditEvent(userId, RIGHT_TO_BE_FORGOTTEN_INITIATED);

      await gdprService.purgeUserData(userId);

      res.json({
        success: true,
        message: "Your data has been successfully erased",
        details: {
          piiPurged: true,
          accountingRecordsAnonymized: true,
          accountDeactivated: true,
        },
      });
    } catch (err) {
      console.error("Right to be forgotten error:", err);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to process erasure request");
    }
  },
};

export default privacyController;
