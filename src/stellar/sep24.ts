import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { sep24RateLimiter } from "../middleware/rateLimit";
import { v4 as uuidv4 } from "uuid";
import { Transaction, Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  getStellarServer,
  getNetworkPassphrase,
  STELLAR_NETWORKS,
} from "../config/stellar";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { enqueueSepWebhook } from "../services/stellar/webhooks";
import {
  generateSignedSep24Url,
  verifySep24Signature,
} from "../utils/sep24Signature";
import {
  calculateDepositFee,
  DepositFeeBreakdown,
  ProviderFeeRates,
  validateDepositLimits,
} from "../services/feeCalculator";

function isValidStellarPublicKey(key: string): boolean {
  try {
    Keypair.fromPublicKey(key);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface Sep24Asset {
  asset_code: string;
  asset_issuer?: string;
  sep6_enabled?: boolean;
  deposits_enabled?: boolean;
  withdrawals_enabled?: boolean;
  transfer_server?: string;
  sep24_enabled?: boolean;
  min_amount?: number;
  max_amount?: number;
  fee_fixed?: number;
  fee_percent?: number;
  /** Optional per-telco fee overrides keyed by provider slug. */
  provider_fees?: Record<string, ProviderFeeRates>;
}

/** Fee preview fields returned with an interactive deposit session. */
export interface InteractiveFeePreview extends DepositFeeBreakdown {}

export interface Sep24InfoResponse {
  deposit: Record<string, Sep24Asset>;
  withdraw: Record<string, Sep24Asset>;
  fee_server?: string;
  features: {
    account_creation: boolean;
    claimable_balances: boolean;
  };
  web_auth_domain?: string;
  issuer?: string;
}

export interface Sep24Transaction {
  id: string;
  kind: "deposit" | "withdrawal";
  status: Sep24TransactionStatus;
  status_ease?: string;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  asset_in?: string;
  asset_out?: string;
  account?: string;
  memo?: string;
  memo_type?: "text" | "hash" | "id";
  from?: string;
  to?: string;
  callback?: string;
  message?: string;
  more_info_url?: string;
  created_at?: string;
  completed_at?: string;
  updated_at?: string;
}

export type Sep24TransactionStatus =
  | "pending_user_transfer_start"
  | "pending_external"
  | "pending_anchor"
  | "pending_trust"
  | "pending_stellar"
  | "completed"
  | "failed"
  | "expired";

export interface DepositRequest {
  asset_code: string;
  amount: string;
  account: string;
  memo?: string;
  email?: string;
  wallet_name?: string;
  wallet_url?: string;
  lang?: string;
  callback?: string;
  success_url?: string;
  failure_url?: string;
  sep9_fields?: Record<string, string>;
  /** Selected mobile-money provider (telco) for the deposit. */
  provider?: string;
}

export interface WithdrawRequest {
  asset_code: string;
  amount: string;
  account: string;
  memo?: string;
  email?: string;
  wallet_name?: string;
  wallet_url?: string;
  lang?: string;
  callback?: string;
  success_url?: string;
  failure_url?: string;
  dest?: string;
  dest_extra?: Record<string, string>;
}

export interface InteractiveFlowResponse {
  url: string;
  id: string;
  /** Upfront fee breakdown for interactive deposits only. */
  fee_preview?: InteractiveFeePreview;
}

const transactions = new Map<string, Sep24Transaction>();

// Token limits: max active interactive transactions per account
const MAX_ACTIVE_TRANSACTIONS_PER_ACCOUNT = 5;
const activeTransactionsPerAccount = new Map<string, number>();

// ============================================================================
// Configuration
// ============================================================================

/**
 * Optional telco-specific fee overrides, supplied as a JSON object:
 *   {"mtn":{"fee_fixed":50,"fee_percent":1},"airtel":{"fee_percent":0.5}}
 * Invalid JSON is ignored so a bad env var cannot take deposits offline.
 */
const parseProviderFees = (
  raw: string | undefined,
): Record<string, ProviderFeeRates> | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, ProviderFeeRates>)
      : undefined;
  } catch {
    logger.warn("[sep24] Invalid SEP24_PROVIDER_FEES_JSON; ignoring");
    return undefined;
  }
};

export const getSep24Config = () => ({
  webAuthDomain:
    process.env.STELLAR_WEB_AUTH_DOMAIN || "https://api.mobilemoney.com",
  interactiveUrlBase:
    process.env.SEP24_INTERACTIVE_URL ||
    "https://wallet.mobilemoney.com/deposit",
  secretKey: process.env.STELLAR_ISSUER_SECRET || "",
  assets: {
    XLM: {
      asset_code: "XLM",
      sep6_enabled: true,
      deposits_enabled: true,
      withdrawals_enabled: true,
      transfer_server:
        process.env.STELLAR_HORIZON_URL ||
        "https://horizon-testnet.stellar.org",
      sep24_enabled: true,
      min_amount: 1,
      max_amount: 1000000,
      fee_fixed: Number(process.env.SEP24_DEPOSIT_FEE_FIXED ?? 0),
      fee_percent: Number(process.env.SEP24_DEPOSIT_FEE_PERCENT ?? 0),
      provider_fees: parseProviderFees(process.env.SEP24_PROVIDER_FEES_JSON),
    } as Sep24Asset,
  } as Record<string, Sep24Asset>,
  features: {
    account_creation: true,
    claimable_balances: true,
  },
});

// ============================================================================
// Logic
// ============================================================================

export const getSep24Info = (): Sep24InfoResponse => {
  const config = getSep24Config();
  const depositAssets: Record<string, Sep24Asset> = {};
  const withdrawAssets: Record<string, Sep24Asset> = {};

  for (const [code, asset] of Object.entries(config.assets)) {
    if (asset.deposits_enabled) depositAssets[code] = asset;
    if (asset.withdrawals_enabled) withdrawAssets[code] = asset;
  }

  return {
    deposit: depositAssets,
    withdraw: withdrawAssets,
    fee_server: process.env.SEP24_FEE_SERVER,
    features: config.features,
    web_auth_domain: config.webAuthDomain,
    issuer: process.env.STELLAR_ISSUER_ACCOUNT,
  };
};

export const generateInteractiveUrl = async (
  request: DepositRequest | WithdrawRequest,
  kind: "deposit" | "withdrawal",
): Promise<InteractiveFlowResponse> => {
  const config = getSep24Config();
  const transactionId = uuidv4();

  // Enforce token limits: reject if account already has too many active transactions
  const currentCount = activeTransactionsPerAccount.get(request.account) || 0;
  if (currentCount >= MAX_ACTIVE_TRANSACTIONS_PER_ACCOUNT) {
    throw new Error(
      `Too many active interactive transactions for account. Limit is ${MAX_ACTIVE_TRANSACTIONS_PER_ACCOUNT}.`,
    );
  }

  const transaction: Sep24Transaction = {
    id: transactionId,
    kind,
    status: "pending_user_transfer_start",
    asset_in: request.asset_code,
    amount_in: request.amount,
    account: request.account,
    memo: request.memo,
    callback: request.callback,
    created_at: new Date().toISOString(),
  };

  transactions.set(transactionId, transaction);
  activeTransactionsPerAccount.set(request.account, currentCount + 1);

  const params = new URLSearchParams({
    transaction_id: transactionId,
    asset_code: request.asset_code,
    amount: request.amount,
    account: request.account,
    lang: request.lang || "en",
  });

  // Upfront deposit fee preview — the interactive screen renders this before
  // the user confirms the mobile-money transfer. Only deposits incur a fee
  // preview; withdrawals keep the existing payload shape.
  let feePreview: InteractiveFeePreview | undefined;
  if (kind === "deposit") {
    const previewAsset =
      config.assets[request.asset_code as keyof typeof config.assets];
    if (previewAsset) {
      feePreview = calculateDepositFee({
        amount: parseFloat(request.amount),
        asset: previewAsset,
        provider: "provider" in request ? request.provider : undefined,
      });
      params.append("fee_fixed", String(feePreview.fee_fixed));
      params.append("fee_percent", String(feePreview.fee_percent));
      params.append("net_amount", String(feePreview.net_amount));
    }
  }

  const depositProvider =
    "provider" in request ? request.provider : undefined;
  if (depositProvider) params.append("provider", depositProvider);
  if (request.memo) params.append("memo", request.memo);
  if (request.email) params.append("email", request.email);
  if (request.wallet_name) params.append("wallet_name", request.wallet_name);
  if (request.wallet_url) params.append("wallet_url", request.wallet_url);
  if (request.success_url) params.append("success_url", request.success_url);
  if (request.failure_url) params.append("failure_url", request.failure_url);

  const callbackUrl = `${config.webAuthDomain}/sep24/callback/${transactionId}`;
  params.append("callback", callbackUrl);

  const baseUrl =
    kind === "deposit"
      ? config.interactiveUrlBase
      : config.interactiveUrlBase.replace("deposit", "withdraw");

  try {
    // Sign the interactive URL with HMAC-SHA256 for query hash validation
    const signedUrl = generateSignedSep24Url(
      baseUrl,
      Object.fromEntries(params),
    );

    return {
      url: signedUrl,
      id: transactionId,
      ...(feePreview ? { fee_preview: feePreview } : {}),
    };
  } catch (error) {
    // Clean up on failure to sign URL
    transactions.delete(transactionId);
    decrementActiveTransactionCount(request.account);
    throw error;
  }
};

export const initiateDeposit = async (
  request: DepositRequest,
): Promise<InteractiveFlowResponse> => {
  const config = getSep24Config();
  const asset = config.assets[request.asset_code as keyof typeof config.assets];

  if (!asset || !asset.deposits_enabled) {
    throw new Error(`Asset ${request.asset_code} is not available for deposit`);
  }

  const amount = parseFloat(request.amount);
  // Single source of truth for limit validation — the same helper powers the
  // fee preview's `limit_error` field, so API errors and the interactive
  // screen cannot disagree about what is allowed.
  const limitError = validateDepositLimits(amount, asset);
  if (limitError) throw new Error(limitError);

  // Validate account
  if (!request.account || !StrKey.isValidEd25519PublicKey(request.account)) {
    throw new Error("Invalid Stellar account address");
  }
  if (!request.account || !isValidStellarPublicKey(request.account))
    throw new Error("Invalid address");
  return generateInteractiveUrl(request, "deposit");
};

export const initiateWithdrawal = async (
  request: WithdrawRequest,
): Promise<InteractiveFlowResponse> => {
  const config = getSep24Config();
  const asset = config.assets[request.asset_code as keyof typeof config.assets];

  if (!asset || !asset.withdrawals_enabled) {
    throw new Error(
      `Asset ${request.asset_code} is not available for withdrawal`,
    );
  }

  const amount = parseFloat(request.amount);
  if (asset.min_amount && amount < asset.min_amount) {
    throw new Error(`Minimum withdrawal amount is ${asset.min_amount}`);
  }
  if (asset.max_amount && amount > asset.max_amount) {
    throw new Error(`Maximum withdrawal amount is ${asset.max_amount}`);
  }

  // Validate account (for withdrawal, this is the source account)
  if (!request.account || !StrKey.isValidEd25519PublicKey(request.account)) {
    throw new Error("Invalid Stellar account address");
  }

  if (!request.account || !isValidStellarPublicKey(request.account))
    throw new Error("Invalid address");

  return generateInteractiveUrl(request, "withdrawal");
};

export const getTransaction = (id: string): Sep24Transaction | undefined =>
  transactions.get(id);

function decrementActiveTransactionCount(account: string): void {
  const current = activeTransactionsPerAccount.get(account) || 0;
  if (current > 0) {
    activeTransactionsPerAccount.set(account, current - 1);
  }
}

export const updateTransactionStatus = (
  id: string,
  status: Sep24TransactionStatus,
  message?: string,
): Sep24Transaction | undefined => {
  const transaction = transactions.get(id);
  if (!transaction) return undefined;

  const statusChanged = transaction.status !== status;
  transaction.status = status;
  transaction.updated_at = new Date().toISOString();
  if (message) transaction.message = message;
  if (status === "completed")
    transaction.completed_at = new Date().toISOString();

  transactions.set(id, transaction);

  // Decrement active count when transaction reaches terminal state
  if (["completed", "failed", "expired"].includes(status)) {
    decrementActiveTransactionCount(transaction.account);
  }

  if (statusChanged && transaction.callback) {
    enqueueSepWebhook(
      transaction.id,
      status,
      transaction.callback,
      transaction,
    ).catch((err) =>
      logger.error(`[sep24-webhook] Error enqueuing webhook:`, err),
    );
  }

  return transaction;
};

export interface CallbackData {
  transaction_id: string;
  status: Sep24TransactionStatus;
  message?: string;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  asset_in?: string;
  asset_out?: string;
  from?: string;
  to?: string;
  memo?: string;
}

export const processCallback = async (
  data: CallbackData,
): Promise<Sep24Transaction | null> => {
  const { transaction_id, status, message, ...extra } = data;
  const transaction = transactions.get(transaction_id);
  if (!transaction) return null;

  const statusChanged = transaction.status !== status;
  transaction.status = status;
  transaction.updated_at = new Date().toISOString();
  transaction.message = message;

  if (extra.amount_in) transaction.amount_in = extra.amount_in;
  if (extra.amount_out) transaction.amount_out = extra.amount_out;
  if (extra.amount_fee) transaction.amount_fee = extra.amount_fee;
  if (extra.asset_in) transaction.asset_in = extra.asset_in;
  if (extra.asset_out) transaction.asset_out = extra.asset_out;
  if (extra.from) transaction.from = extra.from;
  if (extra.to) transaction.to = extra.to;
  if (extra.memo) transaction.memo = extra.memo;

  if (["completed", "failed", "expired"].includes(status)) {
    transaction.completed_at = new Date().toISOString();
    decrementActiveTransactionCount(transaction.account);
  }

  transactions.set(transaction_id, transaction);

  if (statusChanged && transaction.callback) {
    enqueueSepWebhook(
      transaction.id,
      status,
      transaction.callback,
      transaction,
    ).catch((err) =>
      logger.error(`[sep24-webhook] Error enqueuing webhook:`, err),
    );
  }

  return transaction;
};

export const calculateFee = async (
  assetCode: string,
  amount: string,
  _operation: "deposit" | "withdrawal",
  provider?: string,
): Promise<{
  fee: string;
  fee_details?: { fixed: number; percent: number };
  net_amount?: string;
}> => {
  const config = getSep24Config();
  const asset = config.assets[assetCode as keyof typeof config.assets];

  if (!asset) {
    throw new Error(`Asset ${assetCode} not supported`);
  }

  const preview = calculateDepositFee({
    amount: parseFloat(amount),
    asset,
    provider,
  });

  return {
    fee: preview.fee_amount.toFixed(2),
    fee_details: {
      fixed: preview.fee_fixed,
      percent: preview.fee_percent,
    },
    net_amount: preview.net_amount.toFixed(2),
  };
};

// ============================================================================
// Express Router
// ============================================================================

const sep24Router = Router();

const sep24Limiter = sep24RateLimiter;

sep24Router.get("/info", async (_req: Request, res: Response) => {
  try {
    res.json(getSep24Info());
  } catch (_error) {
    // Prefixed with _ to satisfy linter
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to fetch SEP-24 info",
    );
  }
});

sep24Router.get("/fee", async (req: Request, res: Response) => {
  try {
    const { asset_code, amount, operation, provider } = req.query;
    if (!asset_code || !amount || !operation) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Missing params", {
        error: "Missing params",
      });
    }

    const feeInfo = await calculateFee(
      asset_code as string,
      amount as string,
      operation as "deposit" | "withdrawal",
      provider as string | undefined,
    );

    res.json({ asset_code, amount, operation, ...feeInfo });
  } catch (error: any) {
    throw createError(ERROR_CODES.INVALID_INPUT, error.message, {
      error: error.message,
    });
  }
});

sep24Router.post(
  "/deposit",
  sep24Limiter,
  async (req: Request, res: Response) => {
    try {
      const result = await initiateDeposit(req.body);
      res.json(result);
    } catch (error: any) {
      throw createError(ERROR_CODES.INVALID_INPUT, error.message, {
        error: error.message,
      });
    }
  },
);

sep24Router.post(
  "/withdraw",
  sep24Limiter,
  async (req: Request, res: Response) => {
    try {
      const result = await initiateWithdrawal(req.body);
      res.json(result);
    } catch (error: any) {
      throw createError(ERROR_CODES.INVALID_INPUT, error.message, {
        error: error.message,
      });
    }
  },
);

sep24Router.get("/transaction/:id", async (req: Request, res: Response) => {
  const transaction = getTransaction(req.params.id);
  if (!transaction) {
    throw createError(ERROR_CODES.NOT_FOUND, "Not found", {
      error: "Not found",
    });
  }
  res.json(transaction);
});

sep24Router.put("/transaction/:id", async (req: Request, res: Response) => {
  const { status, message } = req.body;
  const transaction = updateTransactionStatus(req.params.id, status, message);
  if (!transaction) {
    throw createError(ERROR_CODES.NOT_FOUND, "Not found", {
      error: "Not found",
    });
  }
  res.json(transaction);
});

// GET callback with SEP-24 query hash validation
sep24Router.get(
  "/callback/:id",
  verifySep24Signature,
  async (req: Request, res: Response) => {
    try {
      const { status, message } = req.query;
      const callbackData: CallbackData = {
        transaction_id: req.params.id,
        status: status as Sep24TransactionStatus,
        message: message as string | undefined,
      };
      const transaction = await processCallback(callbackData);
      if (!transaction) {
        throw createError(ERROR_CODES.NOT_FOUND, "Not found", {
          error: "Not found",
        });
      }

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      let redirectUrl = null;
      if (transaction.status === "completed")
        redirectUrl = `${baseUrl}/sep24/success?id=${req.params.id}`;
      if (["failed", "expired"].includes(transaction.status))
        redirectUrl = `${baseUrl}/sep24/failure?id=${req.params.id}`;

      res.json({
        success: true,
        transaction,
        ...(redirectUrl && { redirect: redirectUrl }),
      });
    } catch (_error) {
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to process callback",
      );
    }
  },
);

sep24Router.post("/callback/:id", async (req: Request, res: Response) => {
  try {
    const callbackData: CallbackData = {
      ...req.body,
      transaction_id: req.params.id,
    };
    const transaction = await processCallback(callbackData);
    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, "Not found", {
        error: "Not found",
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    let redirectUrl = null;
    if (transaction.status === "completed")
      redirectUrl = `${baseUrl}/sep24/success?id=${req.params.id}`;
    if (["failed", "expired"].includes(transaction.status))
      redirectUrl = `${baseUrl}/sep24/failure?id=${req.params.id}`;

    res.json({
      success: true,
      transaction,
      ...(redirectUrl && { redirect: redirectUrl }),
    });
  } catch (_error) {
    // Prefixed with _ to satisfy linter
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to process callback");
  }
});

sep24Router.get("/success", async (req: Request, res: Response) => {
  const transaction = getTransaction(req.query.id as string);
  if (!transaction) {
    throw createError(ERROR_CODES.NOT_FOUND, "Not found", {
      error: "Not found",
    });
  }
  res.json({ success: true, message: "Completed", transaction });
});

sep24Router.get("/failure", async (req: Request, res: Response) => {
  const transaction = getTransaction(req.query.id as string);
  if (!transaction)
    throw createError(ERROR_CODES.NOT_FOUND, "Not found", {
      error: "Not found",
    });
  res.json({
    success: false,
    message: transaction.message || "Failed",
    transaction,
  });
});

sep24Router.get("/health", (_req: Request, res: Response) => {
  const config = getSep24Config();
  res.json({ status: "ok", supported_assets: Object.keys(config.assets) });
});

export default sep24Router;
