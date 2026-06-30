import { Router } from "express";
import { setApiVersion } from "../../middleware/apiVersion";
import { TimeoutPresets, haltOnTimedout } from "../../middleware/timeout";

export const transactionDisputeRoutesV1 = Router();
export const disputeRoutesV1 = Router();

/**
 * V1 Transaction dispute routes
 */

transactionDisputeRoutesV1.post(
  "/:transactionId/dispute",
  TimeoutPresets.long,
  haltOnTimedout,
  setApiVersion("v1"),
  // Add dispute creation handler
);

transactionDisputeRoutesV1.get(
  "/:transactionId/disputes",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  // Add get disputes handler
);

/**
 * V1 Dispute management routes
 */

disputeRoutesV1.get(
  "/",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  // Add list disputes handler
);

disputeRoutesV1.get(
  "/:disputeId",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  // Add get dispute handler
);

disputeRoutesV1.patch(
  "/:disputeId",
  TimeoutPresets.long,
  haltOnTimedout,
  setApiVersion("v1"),
  // Add update dispute handler
);
