import { Router } from "express";
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
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { authenticateToken } from "../middleware/auth";
import { checkAccountStatusStrict } from "../middleware/checkAccountStatus";

export const transactionRoutes = Router();

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
  TimeoutPresets.long,
  haltOnTimedout,
  validateTransaction,
  depositHandler,
);

transactionRoutes.post(
  "/withdraw",
  authenticateToken,
  checkAccountStatusStrict,
  TimeoutPresets.long,
  haltOnTimedout,
  validateTransaction,
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
