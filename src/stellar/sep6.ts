import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { StrKey } from "stellar-sdk";
import { Pool } from "pg";
import { Sep12Service, Sep12CustomerStatus } from "./sep12";

const getSep6Config = () => ({
  transferServer: process.env.STELLAR_TRANSFER_SERVER || "https://api.mobilemoney.com",
  anchorStellarAccount: process.env.STELLAR_ISSUER_ACCOUNT || "G_YOUR_ANCHOR_ACCOUNT",
  assets: {
    XLM: {
      asset_code: "XLM",
      deposits_enabled: true,
      withdrawals_enabled: true,
      min_amount: 1,
      max_amount: 1000000,
      fee_fixed: 0.5,
      fee_percent: 1,
    },
  },
});

export const createSep6Router = (db: Pool): Router => {
  const sep6Router = Router();
  const sep12Service = new Sep12Service(db);

  // TODO: Replace with database
  const transactions = new Map<string, any>();

  /**
   * GET /info
   * Returns supported assets and required fields for deposit/withdrawal
   */
  sep6Router.get("/info", (req: Request, res: Response) => {
    const config = getSep6Config();
    const deposit: any = {};
    const withdraw: any = {};

    for (const [code, asset] of Object.entries(config.assets)) {
      if (asset.deposits_enabled) {
        deposit[code] = {
          enabled: true,
          fee_fixed: asset.fee_fixed,
          fee_percent: asset.fee_percent,
          min_amount: asset.min_amount,
          max_amount: asset.max_amount,
          fields: {
            email_address: { description: "Email address for receipt", optional: true }
            // TODO: Add SEP-9 fields if KYC is supported directly here
          },
        };
      }
      if (asset.withdrawals_enabled) {
        withdraw[code] = {
          enabled: true,
          fee_fixed: asset.fee_fixed,
          fee_percent: asset.fee_percent,
          min_amount: asset.min_amount,
          max_amount: asset.max_amount,
          types: {
            bank_account: {
              fields: {
                dest: { description: "Bank account number", optional: false },
                dest_extra: { description: "Routing number", optional: false },
              },
            },
          },
        };
      }
    }

    res.json({
      deposit,
      withdraw,
      fee: { enabled: true },
      features: { account_creation: true, claimable_balances: true },
    });
  });

  /**
   * GET /deposit
   * Returns instructions (how) for the user to deposit fiat.
   */
  sep6Router.get("/deposit", async (req: Request, res: Response) => {
    try {
      const { asset_code, account, memo, memo_type, email_address } = req.query;

      if (!asset_code || !account) {
        return res.status(400).json({ error: "asset_code and account are required" });
      }

      if (!StrKey.isValidEd25519PublicKey(account as string)) {
        return res.status(400).json({ error: "invalid 'account'" });
      }

      const customer = await sep12Service.getCustomer(
        account as string,
        memo as string,
        memo_type as string
      );

      if (customer.status === Sep12CustomerStatus.NEEDS_INFO) {
        return res.status(403).json({ type: "non_interactive_customer_info_needed" });
      } else if (customer.status === Sep12CustomerStatus.PROCESSING) {
        return res.status(403).json({ type: "customer_info_status", status: "pending" });
      } else if (customer.status === Sep12CustomerStatus.REJECTED) {
        return res.status(403).json({ type: "customer_info_status", status: "denied" });
      }

      const transactionId = uuidv4();
      const fee_fixed = 0.5;

      transactions.set(transactionId, {
        id: transactionId,
        kind: "deposit",
        status: "pending_user_transfer_start",
        account,
        asset_code,
      });

      res.json({
        how: "Please wire funds to Bank XYZ, Account 123456789, Routing 987654321. Include the transaction ID in the memo.",
        id: transactionId,
        fee_fixed,
        extra_info: {
          message: "Transfers typically take 1-2 business days."
        }
      });
    } catch (error: any) {
      logger.error("[SEP-6 Deposit Error]:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  /**
   * GET /withdraw
   * Returns the anchor's Stellar account where the user should send the digital asset.
   */
  sep6Router.get("/withdraw", async (req: Request, res: Response) => {
    try {
      const { asset_code, type, dest, dest_extra, account } = req.query;
      const config = getSep6Config();

      if (!asset_code || !type || !dest) {
        return res.status(400).json({ error: "asset_code, type, and dest are required" });
      }

      if (account && !StrKey.isValidEd25519PublicKey(account as string)) {
        return res.status(400).json({ error: "invalid 'account'" });
      }

      if (account) {
        const customer = await sep12Service.getCustomer(
          account as string,
          req.query.memo as string,
          req.query.memo_type as string
        );

        if (customer.status === Sep12CustomerStatus.NEEDS_INFO) {
          return res.status(403).json({ type: "non_interactive_customer_info_needed" });
        } else if (customer.status === Sep12CustomerStatus.PROCESSING) {
          return res.status(403).json({ type: "customer_info_status", status: "pending" });
        } else if (customer.status === Sep12CustomerStatus.REJECTED) {
          return res.status(403).json({ type: "customer_info_status", status: "denied" });
        }
      } else {
        return res.status(403).json({ type: "non_interactive_customer_info_needed" });
      }

      const transactionId = uuidv4();
      const memo = transactionId.replace(/-/g, "").substring(0, 32);

      transactions.set(transactionId, {
        id: transactionId,
        kind: "withdrawal",
        status: "pending_user_transfer_start",
        dest,
        dest_extra,
        asset_code,
      });

      res.json({
        account: config.anchorStellarAccount,
        memo,
        memo_type: "text",
        id: transactionId,
        fee_fixed: 0.5,
      });
    } catch (error: any) {
      logger.error("[SEP-6 Withdraw Error]:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  return sep6Router;
};

// Use this while calling this router
export default createSep6Router;