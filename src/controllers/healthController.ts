import { Request, Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import logger from "../utils/logger";

export class HealthController {
  static async getHorizonHealth(req: Request, res: Response) {
    const horizonUrl = process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
    const startTime = Date.now();
    try {
      const server = new StellarSdk.Horizon.Server(horizonUrl, {
        allowHttp: horizonUrl.startsWith("http://"),
      });
      const root = await server.root();
      const latency = Date.now() - startTime;

      return res.json({
        status: "up",
        url: horizonUrl,
        latencyMs: latency,
        horizonVersion: root.horizon_version,
        coreVersion: root.core_version,
        latestLedger: root.ingest_latest_ledger,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      const latency = Date.now() - startTime;
      logger.error("Horizon health check failed:", error);
      return res.status(503).json({
        status: "down",
        url: horizonUrl,
        latencyMs: latency,
        error: error.message || "Connection failed",
        timestamp: new Date().toISOString(),
      });
    }
  }
}
