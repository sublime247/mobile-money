import { Router, Request, Response } from "express";
import { pool, queryRead } from "../config/database";
import { redisClient } from "../config/redis";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { amlService } from "../services/aml";

export const reportsRoutes = Router();

interface ReconciliationQuery {
  startDate: string;
  endDate: string;
  format?: "json" | "csv";
}

interface ReconciliationReport {
  period: {
    start: string;
    end: string;
  };
  summary: {
    totalTransactions: number;
    successfulTransactions: number;
    failedTransactions: number;
    successRate: number;
    totalVolume: number;
    totalFees: number;
  };
  byProvider: {
    [provider: string]: {
      count: number;
      volume: number;
    };
  };
  dailyBreakdown?: Array<{
    date: string;
    totalTransactions: number;
    successfulTransactions: number;
    failedTransactions: number;
    totalVolume: number;
    totalFees: number;
  }>;
}

import { feeService } from "../services/feeService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

// Helper function to calculate fees using dynamic configuration
const calculateFee = async (amount: number): Promise<number> => {
  try {
    const result = await feeService.calculateFee(amount);
    return result.fee;
  } catch (error) {
    console.warn("Failed to calculate dynamic fee, using fallback 2%:", error);
    return amount * 0.02;
  }
};

// Helper function to format CSV
const formatCSV = async (report: ReconciliationReport): Promise<string> => {
  const headers = [
    "Date",
    "Provider",
    "Total Transactions",
    "Successful Transactions",
    "Failed Transactions",
    "Success Rate (%)",
    "Total Volume",
    "Total Fees",
  ];

  const rows = [headers.join(",")];

  // Add summary row
  rows.push(
    [
      report.period.start + " to " + report.period.end,
      "ALL",
      report.summary.totalTransactions.toString(),
      report.summary.successfulTransactions.toString(),
      report.summary.failedTransactions.toString(),
      report.summary.successRate.toString(),
      report.summary.totalVolume.toString(),
      report.summary.totalFees.toString(),
    ].join(","),
  );

  // Add provider breakdown
  for (const [provider, data] of Object.entries(report.byProvider)) {
    const providerFee = await calculateFee(data.volume);
    rows.push(
      [
        report.period.start + " to " + report.period.end,
        provider,
        data.count.toString(),
        "",
        "",
        "",
        data.volume.toString(),
        providerFee.toString(),
      ].join(","),
    );
  }

  // Add daily breakdown if available
  if (report.dailyBreakdown) {
    report.dailyBreakdown.forEach((day) => {
      rows.push(
        [
          day.date,
          "ALL",
          day.totalTransactions.toString(),
          day.successfulTransactions.toString(),
          day.failedTransactions.toString(),
          ((day.successfulTransactions / day.totalTransactions) * 100).toFixed(
            1,
          ),
          day.totalVolume.toString(),
          day.totalFees.toString(),
        ].join(","),
      );
    });
  }

  return rows.join("\n");
};

// GET /api/reports/reconciliation
reportsRoutes.get(
  "/reconciliation",
  haltOnTimedout,
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const {
        startDate,
        endDate,
        format = "json",
      } = req.query as unknown as ReconciliationQuery;

      // Validate required parameters
      if (!startDate || !endDate) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "startDate and endDate query parameters are required",
          {
            error: "Bad Request",
          },
        );
      }

      // Validate date format
      const start = new Date(startDate);
      const end = new Date(endDate);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "Invalid date format. Use YYYY-MM-DD format",
          {
            error: "Bad Request",
          },
        );
      }

      if (start > end) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "startDate must be before or equal to endDate",
          {
            error: "Bad Request",
          },
        );
      }

      // Create cache key
      const cacheKey = `reconciliation_report:${startDate}:${endDate}:${format}`;

      // Try to get from cache first
      if (redisClient?.isOpen) {
        try {
          const cached = await redisClient.get(cacheKey);
          if (cached) {
            console.log(`Cache hit for ${cacheKey}`);
            const cachedStr =
              typeof cached === "string" ? cached : cached.toString();
            return format === "csv"
              ? res.header("Content-Type", "text/csv").send(cachedStr)
              : res.json(JSON.parse(cachedStr));
          }
        } catch (cacheError) {
          console.warn("Cache read failed:", cacheError);
        }
      }

      // Query database for transaction summaries
      const query = `
        SELECT 
          provider,
          status,
          DATE(created_at) as date,
          COUNT(*) as count,
          COALESCE(SUM(amount), 0) as volume
        FROM transactions 
        WHERE DATE(created_at) >= $1 
          AND DATE(created_at) <= $2
        GROUP BY provider, status, DATE(created_at)
        ORDER BY date DESC, provider
      `;

      const result = await queryRead(query, [startDate, endDate]);

      // Process results
      const providerData: {
        [key: string]: {
          count: number;
          volume: number;
          successful: number;
          failed: number;
        };
      } = {};
      const dailyData: {
        [date: string]: {
          total: number;
          successful: number;
          failed: number;
          volume: number;
        };
      } = {};

      let totalTransactions = 0;
      let successfulTransactions = 0;
      let failedTransactions = 0;
      let totalVolume = 0;

      result.rows.forEach((row) => {
        const { provider, status, date, count, volume } = row;

        // Initialize provider data if not exists
        if (!providerData[provider]) {
          providerData[provider] = {
            count: 0,
            volume: 0,
            successful: 0,
            failed: 0,
          };
        }

        // Initialize daily data if not exists
        if (!dailyData[date]) {
          dailyData[date] = { total: 0, successful: 0, failed: 0, volume: 0 };
        }

        const countNum = parseInt(count);
        const volumeNum = parseFloat(volume);

        // Update provider totals
        providerData[provider].count += countNum;
        providerData[provider].volume += volumeNum;

        if (status === "completed") {
          providerData[provider].successful += countNum;
        } else if (status === "failed") {
          providerData[provider].failed += countNum;
        }

        // Update daily totals
        dailyData[date].total += countNum;
        dailyData[date].volume += volumeNum;

        if (status === "completed") {
          dailyData[date].successful += countNum;
        } else if (status === "failed") {
          dailyData[date].failed += countNum;
        }

        // Update grand totals
        totalTransactions += countNum;
        totalVolume += volumeNum;

        if (status === "completed") {
          successfulTransactions += countNum;
        } else if (status === "failed") {
          failedTransactions += countNum;
        }
      });

      // Calculate success rate
      const successRate =
        totalTransactions > 0
          ? (successfulTransactions / totalTransactions) * 100
          : 0;
      const totalFees = await calculateFee(totalVolume);

      // Build provider breakdown
      const byProvider: {
        [provider: string]: { count: number; volume: number };
      } = {};
      Object.entries(providerData).forEach(([provider, data]) => {
        byProvider[provider] = {
          count: data.count,
          volume: data.volume,
        };
      });

      // Build daily breakdown
      const dailyBreakdown = await Promise.all(
        Object.entries(dailyData).map(async ([date, data]) => ({
          date,
          totalTransactions: data.total,
          successfulTransactions: data.successful,
          failedTransactions: data.failed,
          totalVolume: data.volume,
          totalFees: await calculateFee(data.volume),
        })),
      );
      dailyBreakdown.sort((a, b) => a.date.localeCompare(b.date));

      // Build report
      const report: ReconciliationReport = {
        period: {
          start: startDate,
          end: endDate,
        },
        summary: {
          totalTransactions,
          successfulTransactions,
          failedTransactions,
          successRate: Math.round(successRate * 10) / 10, // Round to 1 decimal place
          totalVolume: Math.round(totalVolume * 100) / 100, // Round to 2 decimal places
          totalFees: Math.round(totalFees * 100) / 100,
        },
        byProvider,
        dailyBreakdown,
      };

      // Cache the result for 1 hour (3600 seconds)
      if (redisClient?.isOpen) {
        try {
          const cacheValue =
            format === "csv" ? await formatCSV(report) : JSON.stringify(report);
          await redisClient.setEx(cacheKey, 3600, cacheValue);
          console.log(`Cached ${cacheKey} for 1 hour`);
        } catch (cacheError) {
          console.warn("Cache write failed:", cacheError);
        }
      }

      // Return response
      if (format === "csv") {
        const csv = await formatCSV(report);
        res.header("Content-Type", "text/csv");
        res.header(
          "Content-Disposition",
          `attachment; filename="reconciliation_report_${startDate}_to_${endDate}.csv"`,
        );
        return res.send(csv);
      }

      res.json(report);
    } catch (error) {
      console.error("Error generating reconciliation report:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to generate reconciliation report",
        {
          error: "Internal Server Error",
        },
      );
    }
  },
);

// GET /api/reports/aml
reportsRoutes.get(
  "/aml",
  haltOnTimedout,
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const startDateRaw =
        typeof req.query.startDate === "string"
          ? req.query.startDate
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
              .toISOString()
              .slice(0, 10);
      const endDateRaw =
        typeof req.query.endDate === "string"
          ? req.query.endDate
          : new Date().toISOString().slice(0, 10);

      const startDate = new Date(startDateRaw);
      const endDate = new Date(endDateRaw);

      if (
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime())
      ) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "Invalid date format. Use YYYY-MM-DD format",
          {
            error: "Bad Request",
          },
        );
      }

      if (startDate > endDate) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "startDate must be before or equal to endDate",
          {
            error: "Bad Request",
          },
        );
      }

      const report = amlService.generateReport(startDate, endDate);
      return res.json(report);
    } catch (error) {
      console.error("Error generating AML report:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to generate AML report",
        {
          error: "Internal Server Error",
        },
      );
    }
  },
);
