import logger from "../utils/logger";
import { Request, Response } from "express";
import { AMLAlertModel, AMLAlertFilter } from "../models/amlAlert";
import { TransactionModel } from "../models/transaction";
import { UserModel } from "../models/users";
import { pool } from "../config/database";
import { encryptAES, decryptAES, deriveKey } from "../utils/encryption";
import { env } from "../config/env";

const amlAlertModel = new AMLAlertModel();
const transactionModel = new TransactionModel();
const userModel = new UserModel();

/**
 * List AML alerts with filtering and pagination
 * GET /api/audit/aml/alerts
 * Query params: status, userId, severity, startDate, endDate, limit, offset
 */
export const listAmlAlertsForAudit = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const {
      status,
      userId,
      severity,
      startDate,
      endDate,
      limit,
      offset,
      before,
      after,
    } = req.query;

    const validStatuses = ["pending_review", "reviewed", "dismissed"] as const;
    const validSeverities = ["medium", "high"] as const;

    const filter: AMLAlertFilter = {};

    if (status && typeof status === "string") {
      if (!validStatuses.includes(status as any)) {
        res.status(400).json({
          error: "Invalid status",
          message: "Status must be one of: pending_review, reviewed, dismissed",
        });
        return;
      }
      filter.status = status as any;
    }

    if (userId && typeof userId === "string") {
      filter.userId = userId;
    }

    if (severity && typeof severity === "string") {
      if (!validSeverities.includes(severity as any)) {
        res.status(400).json({
          error: "Invalid severity",
          message: "Severity must be one of: medium, high",
        });
        return;
      }
      filter.severity = severity as any;
    }

    if (startDate && typeof startDate === "string") {
      const parsed = new Date(startDate);
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ error: "Invalid startDate format" });
        return;
      }
      filter.startDate = parsed;
    }

    if (endDate && typeof endDate === "string") {
      const parsed = new Date(endDate);
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ error: "Invalid endDate format" });
        return;
      }
      filter.endDate = parsed;
    }

    if (limit && typeof limit === "string") {
      const parsedLimit = parseInt(limit, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        res.status(400).json({
          error: "Invalid limit",
          message: "Limit must be between 1 and 100",
        });
        return;
      }
      filter.limit = parsedLimit;
    }

    if (offset && typeof offset === "string") {
      const parsedOffset = parseInt(offset, 10);
      if (isNaN(parsedOffset) || parsedOffset < 0) {
        res.status(400).json({
          error: "Invalid offset",
          message: "Offset must be >= 0",
        });
        return;
      }
      filter.offset = parsedOffset;
    }

    if (before && typeof before === "string") {
      filter.before = before;
    }

    if (after && typeof after === "string") {
      filter.after = after;
    }

    const result = await amlAlertModel.list(filter);

    const limitVal = filter.limit ?? 50;
    const pagination: any = {
      total: result.total,
      limit: limitVal,
    };

    if (before || after || filter.before || filter.after) {
      pagination.before = result.alerts.length
        ? Buffer.from(`${result.alerts[0].createdAt}|${result.alerts[0].id}`).toString("base64")
        : null;
      pagination.after = result.alerts.length
        ? Buffer.from(`${result.alerts[result.alerts.length - 1].createdAt}|${result.alerts[result.alerts.length - 1].id}`).toString("base64")
        : null;
      pagination.hasMore = result.hasMore ?? false;
    } else {
      pagination.offset = filter.offset ?? 0;
      pagination.hasMore = result.hasMore ?? false;
    }

    res.json({
      data: result.alerts,
      pagination,
      summary: {
        pendingReview: result.pendingReview,
      },
    });
  } catch (error) {
    logger.error("Failed to list AML alerts for audit:", error);
    res.status(500).json({ error: "Failed to list AML alerts" });
  }
};

/**
 * Get detailed AML alert with transaction and user context
 * GET /api/audit/aml/alerts/:alertId
 */
export const getAmlAlertDetails = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { alertId } = req.params;

    const alert = await amlAlertModel.findById(alertId);
    if (!alert) {
      res.status(404).json({ error: "AML alert not found" });
      return;
    }

    // Fetch related transaction
    const transaction = await transactionModel.findById(alert.transactionId);
    if (!transaction) {
      res.status(404).json({ error: "Related transaction not found" });
      return;
    }

    // Fetch user details
    const user = await userModel.findById(alert.userId);

    // Fetch review history
    const reviewHistory = await amlAlertModel.getReviewHistory(alertId);

    res.json({
      alert,
      transaction: {
        id: transaction.id,
        referenceNumber: transaction.referenceNumber,
        type: transaction.type,
        amount: transaction.amount,
        phoneNumber: transaction.phoneNumber,
        provider: transaction.provider,
        status: transaction.status,
        createdAt: transaction.createdAt,
        tags: transaction.tags,
        metadata: transaction.metadata,
      },
      user: user
        ? {
            id: user.id,
            phoneNumber: user.phoneNumber,
            kycLevel: user.kycLevel,
          }
        : null,
      reviewHistory,
    });
  } catch (error) {
    logger.error("Failed to get AML alert details:", error);
    res.status(500).json({ error: "Failed to get AML alert details" });
  }
};

/**
 * Review an AML alert (update status)
 * PATCH /api/audit/aml/alerts/:alertId/review
 * Body: { status: "reviewed" | "dismissed", reviewNotes?: string }
 */
export const reviewAmlAlert = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { alertId } = req.params;
    const { status, reviewNotes } = req.body;

    if (!req.jwtUser?.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const validStatuses = ["reviewed", "dismissed"];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({
        error: "Invalid status",
        message: "Status must be one of: reviewed, dismissed",
      });
      return;
    }

    if (reviewNotes !== undefined && typeof reviewNotes !== "string") {
      res.status(400).json({
        error: "Invalid reviewNotes",
        message: "reviewNotes must be a string",
      });
      return;
    }

    const updated = await amlAlertModel.review(
      alertId,
      {
        status,
        reviewedBy: req.jwtUser.userId,
        reviewNotes,
      },
      req.jwtUser.userId,
    );

    if (!updated) {
      res.status(404).json({ error: "AML alert not found" });
      return;
    }

    res.json({
      message: "AML alert reviewed successfully",
      alert: updated,
    });
  } catch (error) {
    logger.error("Failed to review AML alert:", error);
    res.status(500).json({ error: "Failed to review AML alert" });
  }
};

/**
 * Search AML alerts by user ID with intensity (severity) filter
 * GET /api/audit/aml/alerts/search
 * Query params: userId (required), intensity (optional: medium|high)
 */
export const searchAmlAlertsByUser = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { userId, intensity, limit, offset, before, after } = req.query;

    if (!userId || typeof userId !== "string") {
      res.status(400).json({
        error: "Missing userId",
        message: "userId query parameter is required",
      });
      return;
    }

    const filter: AMLAlertFilter = { userId };

    if (intensity && typeof intensity === "string") {
      const validIntensities = ["medium", "high"];
      if (!validIntensities.includes(intensity)) {
        res.status(400).json({
          error: "Invalid intensity",
          message: "Intensity must be one of: medium, high",
        });
        return;
      }
      filter.severity = intensity as "medium" | "high";
    }

    if (limit && typeof limit === "string") {
      const parsedLimit = parseInt(limit, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        res.status(400).json({
          error: "Invalid limit",
          message: "Limit must be between 1 and 100",
        });
        return;
      }
      filter.limit = parsedLimit;
    }

    if (offset && typeof offset === "string") {
      const parsedOffset = parseInt(offset, 10);
      if (isNaN(parsedOffset) || parsedOffset < 0) {
        res.status(400).json({
          error: "Invalid offset",
          message: "Offset must be >= 0",
        });
        return;
      }
      filter.offset = parsedOffset;
    }

    if (before && typeof before === "string") {
      filter.before = before;
    }

    if (after && typeof after === "string") {
      filter.after = after;
    }

    const result = await amlAlertModel.list(filter);

    const limitVal = filter.limit ?? 50;
    const pagination: any = {
      total: result.total,
      limit: limitVal,
    };

    if (before || after || filter.before || filter.after) {
      pagination.before = result.alerts.length
        ? Buffer.from(`${result.alerts[0].createdAt}|${result.alerts[0].id}`).toString("base64")
        : null;
      pagination.after = result.alerts.length
        ? Buffer.from(`${result.alerts[result.alerts.length - 1].createdAt}|${result.alerts[result.alerts.length - 1].id}`).toString("base64")
        : null;
      pagination.hasMore = result.hasMore ?? false;
    } else {
      pagination.offset = filter.offset ?? 0;
      pagination.hasMore = result.hasMore ?? false;
    }

    res.json({
      data: result.alerts,
      pagination,
      pendingReview: result.pendingReview,
    });
  } catch (error) {
    logger.error("Failed to search AML alerts by user:", error);
    res.status(500).json({ error: "Failed to search AML alerts" });
  }
};

/**
 * Get AML dashboard statistics
 * GET /api/audit/aml/stats
 */
export const getAmlDashboardStats = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { startDate, endDate } = req.query;

    const filter: AMLAlertFilter = {};

    if (startDate && typeof startDate === "string") {
      filter.startDate = new Date(startDate);
    }

    if (endDate && typeof endDate === "string") {
      filter.endDate = new Date(endDate);
    }

    // Get all alerts for the period
    const allAlerts = await amlAlertModel.list(filter);

    // Get breakdown by status
    const pendingResult = await amlAlertModel.list({
      ...filter,
      status: "pending_review",
    });
    const reviewedResult = await amlAlertModel.list({
      ...filter,
      status: "reviewed",
    });
    const dismissedResult = await amlAlertModel.list({
      ...filter,
      status: "dismissed",
    });

    // Get breakdown by severity
    const highSeverityResult = await amlAlertModel.list({
      ...filter,
      severity: "high",
    });
    const mediumSeverityResult = await amlAlertModel.list({
      ...filter,
      severity: "medium",
    });

    res.json({
      summary: {
        total: allAlerts.total,
        pendingReview: pendingResult.total,
        reviewed: reviewedResult.total,
        dismissed: dismissedResult.total,
        highSeverity: highSeverityResult.total,
        mediumSeverity: mediumSeverityResult.total,
      },
      period: {
        startDate: filter.startDate?.toISOString() || null,
        endDate: filter.endDate?.toISOString() || null,
      },
    });
  } catch (error) {
    logger.error("Failed to get AML dashboard stats:", error);
    res.status(500).json({ error: "Failed to get AML dashboard stats" });
  }
};

/**
 * Manually trigger SAR generation for an alert
 * POST /api/audit/aml/alerts/:alertId/sar
 */
export const markAlertForSAR = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { alertId } = req.params;
    const { generateSAR } = await import("../compliance/sar.js");

    const alert = await amlAlertModel.findById(alertId);
    if (!alert) {
      res.status(404).json({ error: "AML alert not found" });
      return;
    }

    const { pdfUrl, xmlUrl } = await generateSAR(alert.userId, alertId);

    // Record the action in review notes
    await amlAlertModel.review(
      alertId,
      {
        status: "reviewed",
        reviewedBy: req.jwtUser?.userId || "system",
        reviewNotes: `[SAR GENERATED] Manual SAR export triggered. PDF: ${pdfUrl}, XML: ${xmlUrl}`,
      },
      req.jwtUser?.userId || "system",
    );

    res.json({
      message: "SAR reports generated successfully",
      pdfUrl,
      xmlUrl,
    });
  } catch (error) {
    logger.error("Failed to mark alert for SAR:", error);
    res.status(500).json({ error: "Failed to generate SAR reports" });
  }
};

/**
 * Rejection reason codes schema mapping (Issue 1490)
 */
export const RejectionReasonCodes = {
  SANCTIONS_HIT: "SANCTIONS_HIT",
  VELOCITY_LIMIT_EXCEEDED: "VELOCITY_LIMIT_EXCEEDED",
  SUSPICIOUS_STRUCTURING: "SUSPICIOUS_STRUCTURING",
  INVALID_PHONE_FORMAT: "INVALID_PHONE_FORMAT",
} as const;

const getEncryptionKey = (): Buffer => {
  return deriveKey(env.DB_ENCRYPTION_KEY || "dev-key-material-at-least-32-chars-long");
};

export const encryptPiiData = (plaintext: string): any => {
  const key = getEncryptionKey();
  return encryptAES(plaintext, key);
};

export const decryptPiiData = (encrypted: any): string => {
  const key = getEncryptionKey();
  return decryptAES(encrypted, key);
};

/**
 * Helper to log a rejected transaction
 */
export const logTransactionRejection = async (
  userId: string,
  transactionId: string | null,
  reasonCode: string,
  rulesMatched: any,
  piiDetails: Record<string, string>,
  ipAddress?: string,
  userAgent?: string,
): Promise<void> => {
  try {
    const encryptedPii: Record<string, any> = {};
    for (const [key, value] of Object.entries(piiDetails)) {
      encryptedPii[key] = encryptPiiData(value);
    }

    const diff = {
      rejection_reason_code: reasonCode,
      rules_matched: rulesMatched,
      encrypted_pii: encryptedPii,
      transaction_id: transactionId,
      user_id: userId,
    };

    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, resource, resource_id, diff, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        "TRANSACTION_REJECTED",
        "transaction_rejection",
        transactionId || null,
        JSON.stringify(diff),
        ipAddress || null,
        userAgent || null,
      ]
    );
  } catch (err) {
    logger.error("Failed to log transaction rejection:", err);
  }
};

/**
 * Fetch list of blocked/rejected transaction audits with decrypted PII
 * GET /api/audit/rejections
 */
export const getTransactionRejections = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const limit = parseInt(req.query.limit as string || "50", 10);
    const offset = parseInt(req.query.offset as string || "0", 10);

    const query = `
      SELECT id, admin_id AS "adminId", action, resource, resource_id AS "resourceId", diff, ip_address AS "ipAddress", user_agent AS "userAgent", created_at AS "createdAt"
      FROM audit_logs
      WHERE resource = 'transaction_rejection'
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const result = await pool.query(query, [limit, offset]);
    
    const rejections = result.rows.map((row) => {
      const diff = row.diff;
      const decryptedPii: Record<string, string> = {};
      if (diff.encrypted_pii) {
        for (const [key, value] of Object.entries(diff.encrypted_pii)) {
          try {
            decryptedPii[key] = decryptPiiData(value);
          } catch (e) {
            decryptedPii[key] = "[DECRYPTION_FAILED]";
          }
        }
      }

      return {
        id: row.id,
        userId: diff.user_id || row.adminId,
        transactionId: diff.transaction_id || row.resourceId,
        reasonCode: diff.rejection_reason_code,
        rulesMatched: diff.rules_matched,
        piiDetails: decryptedPii,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        createdAt: row.createdAt,
      };
    });

    const countQuery = `SELECT COUNT(*) FROM audit_logs WHERE resource = 'transaction_rejection'`;
    const countResult = await pool.query(countQuery);
    const total = parseInt(countResult.rows[0].count, 10);

    res.json({
      data: rejections,
      pagination: {
        total,
        limit,
        offset,
      },
    });
  } catch (error) {
    logger.error("Failed to fetch transaction rejections:", error);
    res.status(500).json({ error: "Failed to fetch transaction rejections" });
  }
};

/**
 * Fetch audited statistics for blocked transactions
 * GET /api/audit/rejections/stats
 */
export const getTransactionRejectionStats = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const query = `
      SELECT diff->>'rejection_reason_code' AS reason_code, COUNT(*) AS count
      FROM audit_logs
      WHERE resource = 'transaction_rejection'
      GROUP BY diff->>'rejection_reason_code'
    `;
    const result = await pool.query(query);
    
    const stats: Record<string, number> = {};
    let total = 0;
    
    result.rows.forEach((row) => {
      const code = row.reason_code || "UNKNOWN";
      const count = parseInt(row.count, 10);
      stats[code] = count;
      total += count;
    });

    res.json({
      total,
      breakdown: stats,
    });
  } catch (error) {
    logger.error("Failed to fetch transaction rejection stats:", error);
    res.status(500).json({ error: "Failed to fetch transaction rejection stats" });
  }
};
