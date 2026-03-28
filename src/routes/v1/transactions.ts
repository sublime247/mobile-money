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
import { TimeoutPresets, haltOnTimedout } from "../../middleware/timeout";
import { validateTransactionFilters } from "../../utils/transactionFilters";
import { requireAuth } from "../../middleware/auth";
import { checkAccountStatusStrict } from "../../middleware/checkAccountStatus";

export const transactionRoutesV1 = Router();

// Deposit transaction route
transactionRoutesV1.post(
  "/deposit",
  requireAuth,
  checkAccountStatusStrict,
  TimeoutPresets.long,
  haltOnTimedout,
  setApiVersion("v1"),
  depositHandler
);

// Withdraw transaction route
transactionRoutesV1.post(
  "/withdraw",
  requireAuth,
  checkAccountStatusStrict,
  TimeoutPresets.long,
  haltOnTimedout,
  setApiVersion("v1"),
  withdrawHandler
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
  listAmlAlertsHandler
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
  reviewAmlAlertHandler
);

// Get specific transaction
transactionRoutesV1.get(
  "/:id",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  getTransactionHandler
);

// Update transaction notes
transactionRoutesV1.patch(
  "/:id/notes",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  updateNotesHandler
);

// Search transactions
transactionRoutesV1.get(
  "/search",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  searchTransactionsHandler
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
