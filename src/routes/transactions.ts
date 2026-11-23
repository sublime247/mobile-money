import { geoIpFilter } from "../middleware/geoIpFilter";
import logger from "../utils/logger";
import { redisBackpressureGuard } from "../queue/redisBackpressure";
import { Router, Request, Response } from "express";
import {
  cancelTransactionHandler,
  depositHandler,
  getTransactionHandler,
  getTransactionHistoryHandler,
  listAmlAlertsHandler,
  patchMetadataHandler,
  reviewAmlAlertHandler,
  searchTransactionsHandler,
  updateNotesHandler,
  updateMetadataHandler,
  deleteMetadataKeysHandler,
  searchByMetadataHandler,
  withdrawHandler,
} from "../controllers/transactionController";
import { validateTransaction } from "../middleware/validateTransaction";
import { normalizeProvider } from "../middleware/normalizeProvider";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { authenticateToken } from "../middleware/auth";
import { cancelTransactionRateLimiter } from "../middleware/rateLimit";
import { validate2FAForWithdrawal } from "../services/twoFactorWithdrawalService";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { generateTransactionPdfBuffer } from "../services/pdfReceipt";
import { getReceiptJsonHandler } from "../controllers/receiptController";
import { generateShareToken, verifyShareToken } from "../utils/share";
import { createExportRoutes } from "./export";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { complianceMiddlewares } from "../middleware/compliance";
import { strictIdempotency } from "../middleware/idempotency";
import { attachTransactionStream } from "../services/transactionEventStream";

export const transactionRoutes = Router();
transactionRoutes.use(createExportRoutes());

const transactionModel = new TransactionModel();

// Serve a PDF receipt for a single transaction (private - requires auth)
transactionRoutes.get(
  "/:id/receipt",
  TimeoutPresets.quick,
  haltOnTimedout,
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { download } = req.query;

      const transaction = await transactionModel.findById(id);
      if (!transaction)
        throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
          error: "Transaction not found",
        });

      if (transaction.userId !== req.jwtUser?.userId) {
        throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
          error: "You do not have permission to access this transaction",
        });
      }

      const pdf = await generateTransactionPdfBuffer(transaction);

      res.setHeader("Content-Type", "application/pdf");
      const filename = `receipt-${transaction.referenceNumber}.pdf`;
      if (download && String(download) !== "0") {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
      } else {
        res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      }

      res.status(200).send(pdf);
    } catch (err) {
      logger.error("Failed to generate receipt PDF:", err);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to generate receipt PDF",
        {
          error: "Failed to generate receipt PDF",
        },
      );
    }
  },
);

transactionRoutes.get(
  "/:id/invoice",
  TimeoutPresets.quick,
  haltOnTimedout,
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { download } = req.query;

      const transaction = await transactionModel.findById(id);
      if (!transaction)
        return res.status(404).json({ error: "Transaction not found" });

      if (transaction.userId !== req.jwtUser?.userId) {
        return res
          .status(403)
          .json({
            error: "You do not have permission to access this transaction",
          });
      }

      if (transaction.status !== TransactionStatus.Completed)
        return res.status(400).json({
          error:
            "Invoice download is available only for completed transactions",
        });

      const pdf = await generateTransactionPdfBuffer(transaction, {
        title: "Invoice",
      });

      res.setHeader("Content-Type", "application/pdf");
      const filename = `invoice-${transaction.referenceNumber}.pdf`;
      if (download && String(download) === "0") {
        res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      } else {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
      }

      res.status(200).send(pdf);
    } catch (err) {
      logger.error("Failed to generate invoice PDF:", err);
      res.status(500).json({ error: "Failed to generate invoice PDF" });
    }
  },
);

// JSON receipt with itemised multi-currency fee breakdown
transactionRoutes.get(
  "/:id/receipt/json",
  TimeoutPresets.quick,
  haltOnTimedout,
  authenticateToken,
  getReceiptJsonHandler,
);

// Create a shareable URL (public or private) for a transaction receipt
transactionRoutes.post(
  "/:id/receipt/share",
  TimeoutPresets.quick,
  haltOnTimedout,
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { expiresIn = 60 * 60 } = req.body || {};
      const transaction = await transactionModel.findById(id);
      if (!transaction)
        throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
          error: "Transaction not found",
        });
      const token = generateShareToken(id, Number(expiresIn));
      const host = req.get("host") || "";
      const protocol = req.protocol;
      const url = `${protocol}://${host}/api/transactions/shared/receipt/${token}`;

      res.json({
        url,
        expiresAt: Math.floor(Date.now() / 1000) + Number(expiresIn),
      });
    } catch (err) {
      logger.error("Failed to create shareable receipt URL:", err);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to create shareable receipt URL",
        {
          error: "Failed to create shareable receipt URL",
        },
      );
    }
  },
);

// Public endpoint: accept a share token and serve the receipt PDF
transactionRoutes.get(
  "/shared/receipt/:token",
  TimeoutPresets.quick,
  haltOnTimedout,
  async (req: Request, res: Response) => {
    try {
      const { token } = req.params;
      const payload = verifyShareToken(token);
      const transaction = await transactionModel.findById(payload.id);
      if (!transaction)
        throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
          error: "Transaction not found",
        });

      const pdf = await generateTransactionPdfBuffer(transaction);
      const filename = `receipt-${transaction.referenceNumber}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.status(200).send(pdf);
    } catch (err) {
      logger.error("Invalid or expired share token:", err);
      throw createError(
        ERROR_CODES.TOKEN_EXPIRED,
        "Invalid or expired share token",
        {
          error: "Invalid or expired share token",
        },
      );
    }
  },
);

transactionRoutes.get(
  "/",
  TimeoutPresets.quick,
  haltOnTimedout,
  getTransactionHistoryHandler,
);

transactionRoutes.get(
  "/search",
  TimeoutPresets.quick,
  haltOnTimedout,
  searchTransactionsHandler,
);

transactionRoutes.get(
  "/aml/alerts",
  authenticateToken,
  TimeoutPresets.quick,
  haltOnTimedout,
  listAmlAlertsHandler,
);

transactionRoutes.patch(
  "/aml/alerts/:alertId/review",
  authenticateToken,
  TimeoutPresets.quick,
  haltOnTimedout,
  reviewAmlAlertHandler,
);

transactionRoutes.post(
  "/deposit",
  authenticateToken,
  geoIpFilter,
  redisBackpressureGuard,
  strictIdempotency,
  TimeoutPresets.long,
  haltOnTimedout,
  normalizeProvider,
  validateTransaction,
  ...complianceMiddlewares,
  depositHandler,
);

transactionRoutes.post(
  "/withdraw",
  authenticateToken,
  geoIpFilter,
  redisBackpressureGuard,
  strictIdempotency,
  TimeoutPresets.long,
  haltOnTimedout,
  normalizeProvider,
  validateTransaction,
  ...complianceMiddlewares,
  validate2FAForWithdrawal,
  withdrawHandler,
);

// Live transaction progress over Server-Sent Events. Clients reconnecting
// with a `Last-Event-ID` header are replayed the events they missed from the
// bounded ring buffer before live delivery resumes.
transactionRoutes.get("/stream", authenticateToken, async (req, res) => {
  const userId = req.jwtUser?.userId;
  if (!userId) {
    res
      .status(401)
      .json({ error: "Access denied", message: "No token provided" });
    return;
  }

  const rawTransactionId = req.query.transactionId;
  const transactionId =
    typeof rawTransactionId === "string" && rawTransactionId.trim()
      ? rawTransactionId.trim()
      : undefined;

  if (transactionId) {
    try {
      const transaction = await transactionModel.findById(transactionId);
      if (!transaction) {
        res.status(404).json({ error: "Transaction not found" });
        return;
      }
      if (transaction.userId !== userId) {
        res.status(403).json({
          error: "You do not have permission to access this transaction",
        });
        return;
      }
    } catch (err) {
      logger.error("Failed to load transaction for SSE stream:", err);
      res.status(500).json({ error: "Failed to open transaction stream" });
      return;
    }
  }

  attachTransactionStream(req, res, { userId, transactionId });
});

transactionRoutes.get(
  "/:id",
  TimeoutPresets.quick,
  haltOnTimedout,
  getTransactionHandler,
);

transactionRoutes.post(
  "/:id/cancel",
  authenticateToken,
  cancelTransactionRateLimiter,
  TimeoutPresets.quick,
  haltOnTimedout,
  cancelTransactionHandler,
);

transactionRoutes.patch(
  "/:id/notes",
  TimeoutPresets.quick,
  haltOnTimedout,
  updateNotesHandler,
);

// Replace metadata
transactionRoutes.put(
  "/:id/metadata",
  TimeoutPresets.quick,
  haltOnTimedout,
  updateMetadataHandler,
);

// Merge metadata keys
transactionRoutes.patch(
  "/:id/metadata",
  TimeoutPresets.quick,
  haltOnTimedout,
  patchMetadataHandler,
);

// Delete metadata keys
transactionRoutes.delete(
  "/:id/metadata",
  TimeoutPresets.quick,
  haltOnTimedout,
  deleteMetadataKeysHandler,
);

// Search by metadata
transactionRoutes.post(
  "/search/metadata",
  TimeoutPresets.quick,
  haltOnTimedout,
  searchByMetadataHandler,
);
