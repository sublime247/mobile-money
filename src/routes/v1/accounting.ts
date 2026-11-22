import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireFinanceAccess } from "../../middleware/requireFinanceAccess";
import { setApiVersion } from "../../middleware/apiVersion";
import { TimeoutPresets, haltOnTimedout } from "../../middleware/timeout";
import { getFloatForecast } from "../../services/accounting/floatForecastService";
import logger from "../../utils/logger";

export const accountingRoutesV1 = Router();

/**
 * GET /api/v1/accounting/float-forecast
 *
 * Finance dashboard endpoint: per-provider hourly burn rate (7-day moving
 * average), 48h reserve projection and estimated time until float depletion.
 */
accountingRoutesV1.get(
  "/float-forecast",
  requireAuth,
  requireFinanceAccess,
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const forecast = await getFloatForecast();
      for (const alert of forecast.alerts) {
        logger.warn(`[float-forecast] ${alert.message}`);
      }
      res.json(forecast);
    } catch (error) {
      next(error);
    }
  },
);
