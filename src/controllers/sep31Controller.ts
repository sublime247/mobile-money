import { Request, Response } from "express";
import { mapToSep31StandardError } from "../utils/errorMapper";
import logger from "../utils/logger";

export class Sep31Controller {
  async getTransaction(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      // Placeholder for transaction lookup
      res.status(200).json({ id, status: "completed" });
    } catch (error: any) {
      logger.error("SEP-31 getTransaction error:", error);
      const standardError = mapToSep31StandardError(error?.code || error?.message);
      res.status(400).json({
        error: standardError.error,
        message: standardError.message,
        action: standardError.action,
      });
    }
  }

  async sendTransaction(req: Request, res: Response): Promise<void> {
    try {
      // Placeholder for SEP-31 send transaction logic
      res.status(200).json({ status: "pending" });
    } catch (error: any) {
      logger.error("SEP-31 sendTransaction error:", error);
      const providerCode = error?.providerCode || error?.code || error?.message;
      const providerType = req.body?.provider;
      const standardError = mapToSep31StandardError(providerCode, providerType);
      res.status(400).json({
        error: standardError.error,
        message: standardError.message,
        action: standardError.action,
      });
    }
  }
}

export const sep31Controller = new Sep31Controller();
