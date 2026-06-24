import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { sep24RateLimiter as stellarRateLimiter } from "../middleware/rateLimit";
import NodeCache from "node-cache";
import { getStellarServer } from "../config/stellar";
import { validateStellarAddressMiddleware } from "../middleware/validateStellarAddress";

const router = Router();

// 5 min cache
const cache = new NodeCache({ stdTTL: 300 });

// Rate limiter (per IP)
const limiter = stellarRateLimiter;

// Horizon server (pooled — automatic round-robin failover across nodes)
const server = getStellarServer();

router.get(
  "/balance/:address",
  limiter,
  validateStellarAddressMiddleware,
  async (req: Request, res: Response) => {
    const { address } = req.params;

    //Check cache
    const cached = cache.get(address);
    if (cached && typeof cached === "object") {
      return res.json({ ...(cached as Record<string, unknown>), cached: true });
    }

    try {
      // Fetch account
      const account = await server.loadAccount(address);

      let xlmBalance = "0";
      let xlmStroops = "0";
      const assets: any[] = [];

      account.balances.forEach((bal: any) => {
        if (bal.asset_type === "native") {
          xlmBalance = bal.balance;

          // Convert to stroops (1 XLM = 10^7 stroops)
          xlmStroops = (parseFloat(bal.balance) * 1e7).toFixed(0);
        } else {
          assets.push({
            asset_code: bal.asset_code,
            asset_issuer: bal.asset_issuer,
            balance: bal.balance,
          });
        }
      });

      const response = {
        address,
        balance: xlmBalance,
        balanceStroops: xlmStroops,
        assets,
      };

      // Cache result
      cache.set(address, response);

      return res.json(response);
    } catch (error: any) {
      // Handle account not found
      if (error?.response?.status === 404) {
        return res.status(404).json({
          error: "Account not found on Stellar network",
        });
      }

      // Some malformed-but-address-like values can still be rejected by Horizon.
      // For this endpoint, treat them as not found instead of invalid input.
      if (error?.response?.status === 400) {
        return res.status(404).json({
          error: "Account not found on Stellar network",
        });
      }

      logger.error(error);

      return res.status(500).json({
        error: "Failed to fetch account balance",
      });
    }
  },
);

export default router;
