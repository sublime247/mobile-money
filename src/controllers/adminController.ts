import { Request, Response, Router } from "express";
import fs from "fs";
import path from "path";
import winston from "winston";
import {
  getAllCircuitBreakerStatesInfo,
  tripCircuitBreaker,
  forceCloseCircuitBreaker,
  CircuitBreakerStateInfo,
} from "../utils/circuitBreaker";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import { pool } from "../config/database";
import { providerSettingsService } from "../services/providerSettingsService";
import { AuthRequest } from "../middleware/auth";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { coldVaultService } from "../services/stellar/vault";
import { replayDeadLetterJob, listDeadLetterJobs } from "../config/queue";

const transactionModel = new TransactionModel();

// Ensure logs directory exists
const LOGS_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export const OUTAGE_LOG_FILE = path.join(LOGS_DIR, "outages.log");
export const ALERT_LOG_FILE = path.join(LOGS_DIR, "outage-alerts.log");

// Winston Logger instance specifically for telco outages and circuit breaker status updates
export const winstonOutageLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: OUTAGE_LOG_FILE }),
    new winston.transports.File({ filename: ALERT_LOG_FILE, level: "warn" }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

export interface AlertWarning {
  id: string;
  provider: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
  message: string;
  errorRate: number;
  threshold: number;
  timestamp: string;
  engineeringTeamNotified: boolean;
  circuitBreakerState: "OPEN" | "CLOSED" | "HALF-OPEN";
}

// In-memory alert store
const activeAlerts: AlertWarning[] = [];

/**
 * Helper to dispatch alert warnings to engineering teams and log via Winston
 */
export function dispatchEngineeringAlert(alert: Omit<AlertWarning, "id" | "timestamp" | "engineeringTeamNotified">): AlertWarning {
  const alertRecord: AlertWarning = {
    id: `ALERT-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
    ...alert,
    timestamp: new Date().toISOString(),
    engineeringTeamNotified: true,
  };

  activeAlerts.unshift(alertRecord);
  if (activeAlerts.length > 50) {
    activeAlerts.pop();
  }

  // Log to Winston log files
  winstonOutageLogger.warn("ENGINEERING ALERT DISPATCHED", alertRecord);

  return alertRecord;
}

/**
 * Controller: Get Circuit Breaker Status & Outage Dashboard State
 * Acceptance Criteria: Display circuit breaker status cleanly on screen
 */
export const getCircuitBreakerStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const circuitBreakers = getAllCircuitBreakerStatesInfo();

    // Calculate system health metrics
    const totalBreakers = circuitBreakers.length;
    const openBreakers = circuitBreakers.filter((cb) => cb.state === "OPEN").length;
    const degradedBreakers = circuitBreakers.filter((cb) => cb.state === "HALF-OPEN").length;

    let overallHealth = "HEALTHY";
    if (openBreakers > 0) {
      overallHealth = "OUTAGE_DETECTED";
    } else if (degradedBreakers > 0) {
      overallHealth = "DEGRADED";
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      health: overallHealth,
      summary: {
        total: totalBreakers,
        healthy: totalBreakers - openBreakers - degradedBreakers,
        degraded: degradedBreakers,
        outage: openBreakers,
      },
      circuitBreakers,
      activeAlerts,
    });
  } catch (error) {
    winstonOutageLogger.error("Failed to fetch circuit breaker status", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch circuit breaker status");
  }
};

/**
 * Controller: Log Outage Status Updates & update circuit breaker
 * Acceptance Criteria: Log outage status updates to Winston log files.
 */
export const logOutageStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider, status, message, errorRate, errorThreshold, operation = "payment" } = req.body;

    if (!provider || typeof provider !== "string") {
      throw createError(ERROR_CODES.INVALID_INPUT, "Provider is required");
    }

    const currentErrorRate = typeof errorRate === "number" ? errorRate : 0;
    const threshold = typeof errorThreshold === "number" ? errorThreshold : 50;

    let cbState = "CLOSED";
    if (status === "OUTAGE" || currentErrorRate >= threshold) {
      tripCircuitBreaker(provider, operation);
      cbState = "OPEN";
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      provider,
      status,
      message,
      errorRate: currentErrorRate,
      errorThreshold: threshold,
      circuitBreakerState: cbState,
    };

    winstonOutageLogger.info("OUTAGE_STATUS_UPDATE", logEntry);

    let alert;
    if (cbState === "OPEN") {
      alert = dispatchEngineeringAlert({
        provider,
        severity: "CRITICAL",
        message: message || `Outage reported on ${provider} gateway. Error rate: ${currentErrorRate}%`,
        errorRate: currentErrorRate,
        threshold,
        circuitBreakerState: "OPEN",
      });
    }

    res.json({
      success: true,
      logEntry,
      alert,
    });
  } catch (error: any) {
    winstonOutageLogger.error("Failed to log outage status", { error: error.message });
    throw error.statusCode ? error : createError(ERROR_CODES.INTERNAL_ERROR, "Failed to log outage status");
  }
};

/**
 * Test alert warning dispatcher for engineering teams
 */
export const testEngineeringAlert = async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider, severity = "WARNING", message, errorRate = 60, threshold = 50 } = req.body;

    if (!provider) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Provider is required for test alert");
    }

    const alert = dispatchEngineeringAlert({
      provider,
      severity,
      message: message || `Test alert warning for ${provider}`,
      errorRate,
      threshold,
      circuitBreakerState: "HALF-OPEN",
    });

    res.json({
      success: true,
      alert,
    });
  } catch (error: any) {
    throw error.statusCode ? error : createError(ERROR_CODES.INTERNAL_ERROR, "Failed to dispatch test alert");
  }
};

/**
 * Reset circuit breaker status
 */
export const resetCircuitBreakerStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider, operation = "payment" } = req.body;

    if (!provider) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Provider is required to reset circuit breaker");
    }

    forceCloseCircuitBreaker(provider, operation);

    winstonOutageLogger.info("CIRCUIT_BREAKER_RESET", {
      provider,
      operation,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Circuit breaker for ${provider} (${operation}) reset to CLOSED`,
    });
  } catch (error: any) {
    throw error.statusCode ? error : createError(ERROR_CODES.INTERNAL_ERROR, "Failed to reset circuit breaker");
  }
};

/**
 * Retrieve Winston log records
 */
export const getWinstonLogs = async (_req: Request, res: Response): Promise<void> => {
  try {
    let logs: any[] = [];
    if (fs.existsSync(OUTAGE_LOG_FILE)) {
      const content = fs.readFileSync(OUTAGE_LOG_FILE, "utf-8");
      logs = content
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line };
          }
        });
    }

    res.json({
      success: true,
      count: logs.length,
      logs: logs.slice(-100),
    });
  } catch (error) {
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to retrieve logs");
  }
};

/**
 * Admin controller handlers for Cold Wallet Multi-Sig Pipeline
 */
export const createColdVaultTransferHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { vaultPublicKey, destinationPublicKey, amount, assetCode, assetIssuer, memo } = req.body;

    if (!vaultPublicKey || !destinationPublicKey || !amount) {
      throw createError(ERROR_CODES.MISSING_FIELD, "vaultPublicKey, destinationPublicKey, and amount are required");
    }

    const initiatorId = req.user?.id || "admin-system";
    const transfer = await coldVaultService.generateTransferEnvelope(
      vaultPublicKey,
      { destinationPublicKey, amount, assetCode, assetIssuer, memo },
      initiatorId
    );

    res.status(201).json({
      success: true,
      transfer,
    });
  } catch (error: any) {
    throw error.statusCode ? error : createError(ERROR_CODES.INTERNAL_ERROR, error.message || "Failed to generate cold vault transfer");
  }
};

export const listColdVaultTransfersHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const transfers = await coldVaultService.listTransfers();
    res.json({
      success: true,
      transfers,
    });
  } catch (error: any) {
    throw error.statusCode ? error : createError(ERROR_CODES.INTERNAL_ERROR, "Failed to list cold vault transfers");
  }
};

export const registerColdVaultSignatureHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { transferId } = req.params;
    const { signerPublicKey, signedEnvelopeXdr } = req.body;

    if (!transferId || !signerPublicKey || !signedEnvelopeXdr) {
      throw createError(ERROR_CODES.MISSING_FIELD, "transferId, signerPublicKey, and signedEnvelopeXdr are required");
    }

    const transfer = await coldVaultService.registerSignature(transferId, signerPublicKey, signedEnvelopeXdr);

    res.json({
      success: true,
      transfer,
    });
  } catch (error: any) {
    throw error.statusCode ? error : createError(ERROR_CODES.INTERNAL_ERROR, error.message || "Failed to register secondary signature");
  }
};

export const executeColdVaultTransferHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { transferId } = req.params;

    if (!transferId) {
      throw createError(ERROR_CODES.MISSING_FIELD, "transferId is required");
    }

    const result = await coldVaultService.executeTransfer(transferId);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    throw error.statusCode ? error : createError(ERROR_CODES.INTERNAL_ERROR, error.message || "Failed to execute cold vault transfer");
  }
};

export const getDeadLetterJobsHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const queueName = req.query.queueName as string;
    const status = req.query.status as string;

    const result = await listDeadLetterJobs({ limit, offset, queueName, status });
    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    throw error.statusCode ? error : createError(ERROR_CODES.INTERNAL_ERROR, error.message || "Failed to fetch dead letter jobs");
  }
};

export const getDeadLetterJobByIdHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM failed_jobs WHERE id = $1;", [id]);
    if (!result.rows || result.rows.length === 0) {
      throw createError(ERROR_CODES.NOT_FOUND, `Failed job not found with ID: ${id}`);
    }
    res.json({
      success: true,
      job: result.rows[0],
    });
  } catch (error: any) {
    throw error.statusCode ? error : createError(ERROR_CODES.INTERNAL_ERROR, error.message || "Failed to fetch dead letter job");
  }
};

export const replayDeadLetterJobHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      throw createError(ERROR_CODES.MISSING_FIELD, "Failed job ID is required for replay");
    }

    const result = await replayDeadLetterJob(id);
    res.json({
      success: true,
      message: "Failed dead-letter job replayed successfully",
      ...result,
    });
  } catch (error: any) {
    throw error.statusCode ? error : createError(ERROR_CODES.INTERNAL_ERROR, error.message || "Failed to replay dead letter job");
  }
};

const adminRouter = Router();
adminRouter.get("/circuit-breakers", getCircuitBreakerStatus);
adminRouter.post("/outage", logOutageStatus);
adminRouter.post("/test-alert", testEngineeringAlert);
adminRouter.post("/circuit-breakers/reset", resetCircuitBreakerStatus);
adminRouter.get("/logs", getWinstonLogs);
adminRouter.get("/dlq", getDeadLetterJobsHandler);
adminRouter.get("/dlq/:id", getDeadLetterJobByIdHandler);
adminRouter.post("/dlq/replay/:id", replayDeadLetterJobHandler);

export default adminRouter;
