import { Router } from "express";
import { setApiVersion, VersionedRequest } from "../../middleware/apiVersion";
import {
  listAmlAlertsHandler,
  depositHandler,
  withdrawHandler,
  getTransactionHandler,
  reviewAmlAlertHandler,
  updateNotesHandler,
  searchTransactionsHandler,
  listTransactionsHandler,
  updateMetadataHandler,
  patchMetadataHandler,
  deleteMetadataKeysHandler,
  searchByMetadataHandler,
} from "../../controllers/transactionController";
import { validateNetworkMiddleware } from "../../middleware/validateNetworkMiddleware";
import { TimeoutPresets, haltOnTimedout } from "../../middleware/timeout";
import { validateTransactionFilters } from "../../utils/transactionFilters";
import { requireAuth } from "../../middleware/auth";
import { checkAccountStatusStrict } from "../../middleware/checkAccountStatus";
import { geolocateMiddleware } from "../../middleware/geolocate";
import { geoFencingMiddleware } from "../../middleware/geoFencing";
import { createExportRoutes } from "../export";
import { TransactionModel, TransactionStatus } from "../../models/transaction";
import { generateTransactionPdfBuffer } from "../../services/pdfReceipt";
import { validate2FAForWithdrawal } from "../../services/twoFactorWithdrawalService";


export const transactionRoutesV1 = Router();
transactionRoutesV1.use(createExportRoutes());

const transactionModel = new TransactionModel();

// Deposit transaction route
transactionRoutesV1.post(
  "/deposit",
  requireAuth,
  checkAccountStatusStrict,
  geoFencingMiddleware,
  validateNetworkMiddleware,
  TimeoutPresets.long,
  haltOnTimedout,
  setApiVersion("v1"),
  geolocateMiddleware,
  depositHandler,
);

// Withdraw transaction route
transactionRoutesV1.post(
  "/withdraw",
  requireAuth,
  checkAccountStatusStrict,
  geoFencingMiddleware,
  validateNetworkMiddleware,
  TimeoutPresets.long,
  haltOnTimedout,
  setApiVersion("v1"),
  geolocateMiddleware,
  validate2FAForWithdrawal,
  withdrawHandler,
);

// List transactions with status filtering and pagination
transactionRoutesV1.get(
  "/",
  TimeoutPresets.quick,
  haltOnTimedout,
  validateTransactionFilters,
  setApiVersion("v1"),
  listTransactionsHandler,
);

// Get specific transaction
transactionRoutesV1.get(
  "/aml/alerts",
  requireAuth,
  TimeoutPresets.quick,
  haltOnTimedout,
  (req: VersionedRequest, _res, next) => {
    req.apiVersion = "v1";
    next();
  },
  listAmlAlertsHandler,
);

transactionRoutesV1.patch(
  "/aml/alerts/:alertId/review",
  requireAuth,
  TimeoutPresets.quick,
  haltOnTimedout,
  (req: VersionedRequest, _res, next) => {
    req.apiVersion = "v1";
    next();
  },
  reviewAmlAlertHandler,
);

// Get specific transaction
transactionRoutesV1.get(
  "/:id",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  getTransactionHandler,
);

transactionRoutesV1.get(
  "/:id/invoice",
  TimeoutPresets.quick,
  haltOnTimedout,
  requireAuth,
  setApiVersion("v1"),
  async (req: VersionedRequest, res) => {
    try {
      const { id } = req.params;
      const { download } = req.query;

      const transaction = await transactionModel.findById(id);
      if (!transaction)
        return res.status(404).json({ error: "Transaction not found" });

      if (transaction.status !== TransactionStatus.Completed)
        return res.status(400).json({
          error: "Invoice download is available only for completed transactions",
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
      console.error("Failed to generate invoice PDF:", err);
      res.status(500).json({ error: "Failed to generate invoice PDF" });
    }
  },
);

// Update transaction notes
transactionRoutesV1.patch(
  "/:id/notes",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  updateNotesHandler,
);

// Search transactions
transactionRoutesV1.get(
  "/search",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  searchTransactionsHandler,
);

// Replace metadata
transactionRoutesV1.put(
  "/:id/metadata",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  updateMetadataHandler,
);

// Merge metadata keys
transactionRoutesV1.patch(
  "/:id/metadata",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  patchMetadataHandler,
);

// Delete metadata keys
transactionRoutesV1.delete(
  "/:id/metadata",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  deleteMetadataKeysHandler,
);

// Search by metadata
transactionRoutesV1.post(
  "/search/metadata",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  searchByMetadataHandler,
);
