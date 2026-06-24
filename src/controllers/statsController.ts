import logger from "../utils/logger";
import { Request, Response } from "express";
import { StatsService } from "../services/statsService";
import { Cache } from "../services/cache";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const statsService = new StatsService();

export class StatsController {
  /**
   * GET /api/stats
   * Get system-wide statistics and metrics
   */
  @Cache()
  static async getStats(req: Request, res: Response) {
    try {
      const { startDate, endDate } = req.query;

      const start = startDate ? new Date(startDate as string) : undefined;
      const end = endDate ? new Date(endDate as string) : undefined;

      // Validate dates
      if (startDate && isNaN(start!.getTime())) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "Invalid startDate format",
          {
            error: "Invalid startDate format",
          },
        );
      }
      if (endDate && isNaN(end!.getTime())) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Invalid endDate format", {
          error: "Invalid endDate format",
        });
      }

      // Fetch stats from service
      const [general, byProvider, activeUsers, trends] = await Promise.all([
        statsService.getGeneralStats(start, end),
        statsService.getVolumeByProvider(start, end),
        statsService.getActiveUsersCount(start, end),
        statsService.getVolumeByPeriod("day", start, end),
      ]);

      const response = {
        totalTransactions: general.totalTransactions,
        successRate: parseFloat(general.successRate.toFixed(2)),
        totalVolume: general.totalVolume,
        averageAmount: parseFloat(general.averageAmount.toFixed(2)),
        activeUsers,
        byProvider,
        trends,
        timestamp: new Date().toISOString(),
        cached: false,
      };
      return res.json(response);
    } catch (error) {
      logger.error("Error fetching stats:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to calculate statistics",
        {
          error: "Internal server error",
        },
      );
    }
  }
}
