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
import { validateNetworkMiddleware } from "../middleware/validateNetworkMiddleware";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { authenticateToken } from "../middleware/auth";
import { cancelTransactionRateLimiter } from "../middleware/rateLimit";
import { checkAccountStatusStrict } from "../middleware/checkAccountStatus";
import { geolocateMiddleware } from "../middleware/geolocate";
import { geoFencingMiddleware } from "../middleware/geoFencing";
import { TransactionModel } from "../models/transaction";
import { generateTransactionPdfBuffer } from "../services/pdfReceipt";
import { generateShareToken, verifyShareToken } from "../utils/share";
import { createExportRoutes } from "./export";

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
        return res.status(404).json({ error: "Transaction not found" });

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
      console.error("Failed to generate receipt PDF:", err);
      res.status(500).json({ error: "Failed to generate receipt PDF" });
    }
  },
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
        return res.status(404).json({ error: "Transaction not found" });

      const token = generateShareToken(id, Number(expiresIn));
      const host = req.get("host") || "";
      const protocol = req.protocol;
      const url = `${protocol}://${host}/api/transactions/shared/receipt/${token}`;

      res.json({
        url,
        expiresAt: Math.floor(Date.now() / 1000) + Number(expiresIn),
      });
    } catch (err) {
      console.error("Failed to create shareable receipt URL:", err);
      res.status(500).json({ error: "Failed to create shareable receipt URL" });
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
        return res.status(404).json({ error: "Transaction not found" });

      const pdf = await generateTransactionPdfBuffer(transaction);
      const filename = `receipt-${transaction.referenceNumber}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.status(200).send(pdf);
    } catch (err) {
      console.error("Invalid or expired share token:", err);
      return res.status(401).json({ error: "Invalid or expired share token" });
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
  checkAccountStatusStrict,
  geoFencingMiddleware,
  TimeoutPresets.long,
  haltOnTimedout,
  normalizeProvider,
  validateTransaction,
  validateNetworkMiddleware,
  geolocateMiddleware,
  depositHandler,
);

transactionRoutes.post(
  "/withdraw",
  authenticateToken,
  checkAccountStatusStrict,
  geoFencingMiddleware,
  TimeoutPresets.long,
  haltOnTimedout,
  normalizeProvider,
  validateTransaction,
  validateNetworkMiddleware,
  geolocateMiddleware,
  withdrawHandler,
);

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
