import { isIP } from "node:net";
import { NextFunction, Request, Response } from "express";
import logger from "../utils/logger";
import { blacklistIp } from "./ipBlacklist";
import { extractClientIp } from "./geolocate";

type BlacklistIp = (ip: string) => Promise<void>;

export function createHoneypotValidator(
  blacklist: BlacklistIp = blacklistIp,
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const honeypotValue = req.body?.company_fax;
    if (typeof honeypotValue !== "string" || honeypotValue.trim() === "") {
      next();
      return;
    }

    const ip = extractClientIp(req);
    if (!ip || !isIP(ip)) {
      next(new Error("Cannot blacklist honeypot submission without a valid client IP"));
      return;
    }

    try {
      await blacklist(ip);
      logger.warn({ ip, route: req.originalUrl }, "Payment-link honeypot triggered");
      res.status(200).json({
        message: "Payment initiated successfully",
        redirectUrl: "/pay/result/success",
      });
    } catch (error) {
      next(error);
    }
  };
}

export const honeypotValidator = createHoneypotValidator();
