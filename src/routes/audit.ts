import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { authorizeObj } from "../middleware/rbac";
import {
  listAmlAlertsForAudit,
  getAmlAlertDetails,
  reviewAmlAlert,
  searchAmlAlertsByUser,
  getAmlDashboardStats,
} from "../controllers/amlAuditController";

export const auditRoutes = Router();

// All audit routes require authentication
auditRoutes.use(authenticateToken);

/**
 * AML Audit Dashboard Routes
 * Read-only view for compliance officers to review flagged transactions
 */

// List all AML alerts with filtering and pagination
auditRoutes.get(
  "/aml/alerts",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "read"),
  listAmlAlertsForAudit,
);

// Search AML alerts by userId and intensity (severity)
auditRoutes.get(
  "/aml/alerts/search",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "read"),
  searchAmlAlertsByUser,
);

// Get AML dashboard statistics
auditRoutes.get(
  "/aml/stats",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "read"),
  getAmlDashboardStats,
);

// Get detailed AML alert with transaction context
auditRoutes.get(
  "/aml/alerts/:alertId",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "read"),
  getAmlAlertDetails,
);

// Review an AML alert (update status to reviewed/dismissed)
auditRoutes.patch(
  "/aml/alerts/:alertId/review",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "write"),
  reviewAmlAlert,
);
