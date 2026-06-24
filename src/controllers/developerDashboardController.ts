import logger from "../utils/logger";
import { Request, Response } from "express";
import { DeveloperDashboardService } from "../services/developerDashboardService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const service = new DeveloperDashboardService();

export class DeveloperDashboardController {
  /**
   * GET /api/developer/dashboard
   * Returns rate limit usage stats for the authenticated partner
   */
  static async getDashboard(req: Request, res: Response) {
    try {
      const partnerId = (req as any).user?.id;
      if (!partnerId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
          error: "Unauthorized",
        });
      }

      const stats = await service.getUsageStats(partnerId);
      return res.json(stats);
    } catch (error) {
      logger.error("Developer dashboard error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch dashboard stats",
      );
    }
  }
}
