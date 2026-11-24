import logger from "../utils/logger";
import { Router, Request, Response, json } from "express";
import { v4 as uuidv4 } from "uuid";
import { StrKey } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { Sep12Service, Sep12CustomerStatus } from "./sep12";
import { PostgresSep24TransactionStore } from "./sep24Store";

import { sep6InfoResponseSchema, Sep6InfoResponse } from "../schemas/sep6";
import { validateCemacRib } from "../utils/bankValidator";

export interface Sep6AssetConfig {
  asset_code: string;
  deposits_enabled?: boolean;
  withdrawals_enabled?: boolean;
  min_amount?: number;
  max_amount?: number;
  fee_fixed?: number;
  fee_percent?: number;
  [key: string]: any;
}

export interface Sep6Config {
  transferServer: string;
  anchorStellarAccount: string;
  assets: Record<string, Sep6AssetConfig>;
}

export const getSep6Config = (): Sep6Config => ({
  transferServer:
    process.env.STELLAR_TRANSFER_SERVER || "https://api.mobilemoney.com",
  anchorStellarAccount:
    process.env.STELLAR_ISSUER_ACCOUNT || "G_YOUR_ANCHOR_ACCOUNT",
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

/**
 * Builds the raw SEP-6 /info response object from corridor configuration
 */
export const buildSep6InfoPayload = (config: Sep6Config = getSep6Config()) => {
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
          email_address: {
            description: "Email address for receipt",
            optional: true,
          },
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

  return {
    deposit,
    withdraw,
    fee: { enabled: true },
    transactions: { enabled: true, authentication_required: true },
    transaction: { enabled: true, authentication_required: true },
    features: { account_creation: true, claimable_balances: true },
  };
};

/**
 * Validates corridor config by constructing and parsing the /info payload.
 */
export const validateSep6CorridorConfig = (
  config: Sep6Config = getSep6Config(),
): Sep6InfoResponse => {
  const payload = buildSep6InfoPayload(config);
  return sep6InfoResponseSchema.parse(payload);
};

export const createSep6Router = (db: Pool): Router => {
  const sep6Router = Router();
  const sep12Service = new Sep12Service(db);

  // Validate corridor config on router initialization; logs error if misconfigured
  try {
    validateSep6CorridorConfig();
  } catch (err: any) {
    logger.error(
      { error: err.message, issues: err.issues },
      "[SEP-6 Init Error]: Startup corridor configuration schema violation",
    );
  }

  // TODO: Replace with database
  const transactions = new Map<string, any>();

  /**
   * GET /info
   * Returns supported assets and required fields for deposit/withdrawal,
   * parsed and validated against sep6InfoResponseSchema.
   */
  sep6Router.get("/info", (req: Request, res: Response) => {
    try {
      const config = getSep6Config();
      const payload = buildSep6InfoPayload(config);
      const validated = sep6InfoResponseSchema.parse(payload);
      return res.json(validated);
    } catch (error: any) {
      logger.error(
        { error: error.message, issues: error.issues },
        "[SEP-6 Info Schema Error]: Outgoing /info payload failed validation",
      );
      return res.status(500).json({
        error: "Internal Server Error: Invalid corridor configuration",
        details: error.issues || error.message,
      });
    }
  });

  /**
   * GET /deposit
   * Returns instructions (how) for the user to deposit fiat.
   */
  sep6Router.get("/deposit", async (req: Request, res: Response) => {
    try {
      const { asset_code, account, memo, memo_type, email_address } = req.query;

      if (!asset_code || !account) {
        return res
          .status(400)
          .json({ error: "asset_code and account are required" });
      }

      if (!StrKey.isValidEd25519PublicKey(account as string)) {
        return res.status(400).json({ error: "invalid 'account'" });
      }

      const customer = await sep12Service.getCustomer(
        account as string,
        memo as string,
        memo_type as string,
      );

      if (customer.status === Sep12CustomerStatus.NEEDS_INFO) {
        return res
          .status(403)
          .json({ type: "non_interactive_customer_info_needed" });
      } else if (customer.status === Sep12CustomerStatus.PROCESSING) {
        return res
          .status(403)
          .json({ type: "customer_info_status", status: "pending" });
      } else if (customer.status === Sep12CustomerStatus.REJECTED) {
        return res
          .status(403)
          .json({ type: "customer_info_status", status: "denied" });
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

      // Persist so bank statement reconciliation can find the pending deposit
      // and release it once the customer's wire arrives.
      try {
        const amount = req.query.amount ? String(req.query.amount) : undefined;
        await new PostgresSep24TransactionStore().save({
          id: transactionId,
          kind: "deposit",
          status: "pending_user_transfer_start",
          account: account as string,
          asset_in: asset_code as string,
          amount_in: amount,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      } catch (persistError) {
        logger.error("[SEP-6 Deposit] Failed to persist deposit:", persistError);
      }

      res.json({
        how: "Please wire funds to Bank XYZ, Account 123456789, Routing 987654321. Include the transaction ID in the memo.",
        id: transactionId,
        fee_fixed,
        extra_info: {
          message: "Transfers typically take 1-2 business days.",
        },
      });
    } catch (error: any) {
      logger.error("[SEP-6 Deposit Error]:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  /**
   * Withdrawal handler shared by GET /withdraw (SEP-6) and POST /withdraw.
   * Returns the anchor's Stellar account where the user should send the
   * digital asset, after validating any supplied CEMAC RIB.
   */
  type WithdrawParams = Record<string, unknown>;

  const firstString = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return undefined;
  };

  const handleWithdraw = async (params: WithdrawParams, res: Response) => {
    try {
      const asset_code = firstString(params.asset_code);
      const type = firstString(params.type);
      const dest =
        firstString(params.dest) ?? firstString(params.rib) ?? undefined;
      const dest_extra = firstString(params.dest_extra);
      const account = firstString(params.account);
      const countryCode =
        firstString(params.country_code) ??
        firstString(params.bank_country_code) ??
        firstString(params.dest_country_code);
      const config = getSep6Config();

      if (!asset_code || !type || !dest) {
        return res
          .status(400)
          .json({ error: "asset_code, type, and dest are required" });
      }

      if (account && !StrKey.isValidEd25519PublicKey(account)) {
        return res.status(400).json({ error: "invalid 'account'" });
      }

      // Validate the destination bank identifier before creating any
      // withdrawal transaction (#2431). CEMAC countries use a 23-digit RIB
      // with a modulo-97 key; non-CEMAC corridors are left untouched.
      const ribValidation = validateCemacRib(dest, countryCode, "dest");
      if (!ribValidation.valid) {
        return res.status(400).json({
          error: "invalid_rib",
          message: ribValidation.error,
          details: {
            field: "dest",
            country: countryCode ?? ribValidation.country ?? null,
          },
        });
      }

      if (account) {
        const customer = await sep12Service.getCustomer(
          account,
          firstString(params.memo),
          firstString(params.memo_type),
        );

        if (customer.status === Sep12CustomerStatus.NEEDS_INFO) {
          return res
            .status(403)
            .json({ type: "non_interactive_customer_info_needed" });
        } else if (customer.status === Sep12CustomerStatus.PROCESSING) {
          return res
            .status(403)
            .json({ type: "customer_info_status", status: "pending" });
        } else if (customer.status === Sep12CustomerStatus.REJECTED) {
          return res
            .status(403)
            .json({ type: "customer_info_status", status: "denied" });
        }
      } else {
        return res
          .status(403)
          .json({ type: "non_interactive_customer_info_needed" });
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
  };

  sep6Router.get("/withdraw", (req: Request, res: Response) => {
    void handleWithdraw(req.query as WithdrawParams, res);
  });

  sep6Router.post("/withdraw", json(), (req: Request, res: Response) => {
    void handleWithdraw(req.body ?? {}, res);
  });

  return sep6Router;
};

// Use this while calling this router
export default createSep6Router;
