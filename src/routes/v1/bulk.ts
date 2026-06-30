import { Router } from "express";
import { VersionedRequest } from "../../middleware/apiVersion";
import { TimeoutPresets, haltOnTimedout } from "../../middleware/timeout";

export const bulkRoutesV1 = Router();

/**
 * V1 Bulk operations routes
 * Handles bulk transaction processing
 */

bulkRoutesV1.post(
  "/",
  TimeoutPresets.long,
  haltOnTimedout,
  (req: VersionedRequest, res, next) => {
    req.apiVersion = "v1";
    next();
  },
  // Add your bulk operations handler here
);

bulkRoutesV1.get(
  "/:batchId",
  TimeoutPresets.quick,
  haltOnTimedout,
  (req: VersionedRequest, res, next) => {
    req.apiVersion = "v1";
    next();
  },
  // Add your batch status handler here
);
