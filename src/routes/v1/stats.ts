import { Router } from "express";
import { setApiVersion } from "../../middleware/apiVersion";
import { TimeoutPresets, haltOnTimedout } from "../../middleware/timeout";

export const statsRoutesV1 = Router();

/**
 * V1 Statistics and analytics routes
 */

statsRoutesV1.get(
  "/summary",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  // Add stats summary handler
);

statsRoutesV1.get(
  "/daily",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  // Add daily stats handler
);

statsRoutesV1.get(
  "/",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  // Add general stats handler
);
