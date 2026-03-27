import { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { Transaction, Keypair } from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase, STELLAR_NETWORKS } from "../config/stellar";

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
}

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
  // Timestamps
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
  // KYC fields
  sep9_fields?: Record<string, string>;
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
  // Destination fields
  dest?: string;
  dest_extra?: Record<string, string>;
}

export interface InteractiveFlowResponse {
  url: string;
  id: string;
}

// In-memory store for transactions (in production, use a database)
const transactions = new Map<string, Sep24Transaction>();

// ============================================================================
// Configuration
// ============================================================================

const getSep24Config = () => ({
  webAuthDomain: process.env.STELLAR_WEB_AUTH_DOMAIN || "https://api.mobilemoney.com",
  interactiveUrlBase: process.env.SEP24_INTERACTIVE_URL || "https://wallet.mobilemoney.com/deposit",
  secretKey: process.env.STELLAR_ISSUER_SECRET || "",
  // Supported assets configuration
  assets: {
    XLM: {
      asset_code: "XLM",
      sep6_enabled: true,
      deposits_enabled: true,
      withdrawals_enabled: true,
      transfer_server: process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org",
      sep24_enabled: true,
      min_amount: 1,
      max_amount: 1000000,
    } as Sep24Asset,
    // Add more assets as needed
  },
  // Feature flags
  features: {
    account_creation: true,
    claimable_balances: true,
  },
});

// ============================================================================
// SEP-24 Info Endpoint
// ============================================================================

export const getSep24Info = (): Sep24InfoResponse => {
  const config = getSep24Config();
  
  // Build deposit and withdraw asset objects
  const depositAssets: Record<string, Sep24Asset> = {};
  const withdrawAssets: Record<string, Sep24Asset> = {};

  for (const [code, asset] of Object.entries(config.assets)) {
    if (asset.deposits_enabled) {
      depositAssets[code] = asset;
    }
    if (asset.withdrawals_enabled) {
      withdrawAssets[code] = asset;
    }
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

// ============================================================================
// Interactive URL Generation
// ============================================================================

export const generateInteractiveUrl = async (
  request: DepositRequest | WithdrawRequest,
  kind: "deposit" | "withdrawal"
): Promise<InteractiveFlowResponse> => {
  const config = getSep24Config();
  const transactionId = uuidv4();

  // Create initial transaction record
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

  // Store transaction
  transactions.set(transactionId, transaction);

  // Build interactive URL with query parameters
  const params = new URLSearchParams({
    transaction_id: transactionId,
    asset_code: request.asset_code,
    amount: request.amount,
    account: request.account,
    lang: request.lang || "en",
  });

  if (request.memo) {
    params.append("memo", request.memo);
  }

  if (request.email) {
    params.append("email", request.email);
  }

  if (request.wallet_name) {
    params.append("wallet_name", request.wallet_name);
  }

  if (request.wallet_url) {
    params.append("wallet_url", request.wallet_url);
  }

  if (request.success_url) {
    params.append("success_url", request.success_url);
  }

  if (request.failure_url) {
    params.append("failure_url", request.failure_url);
  }

  // Add callback
  const callbackUrl = `${config.webAuthDomain}/sep24/callback/${transactionId}`;
  params.append("callback", callbackUrl);

  // Build the final URL
  const baseUrl = kind === "deposit" 
    ? config.interactiveUrlBase 
    : config.interactiveUrlBase.replace("deposit", "withdraw");

  const interactiveUrl = `${baseUrl}?${params.toString()}`;

  return {
    url: interactiveUrl,
    id: transactionId,
  };
};

// ============================================================================
// Deposit Flow
// ============================================================================

export const initiateDeposit = async (
  request: DepositRequest
): Promise<InteractiveFlowResponse> => {
  // Validate asset is supported
  const config = getSep24Config();
  const asset = config.assets[request.asset_code];

  if (!asset || !asset.deposits_enabled) {
    throw new Error(`Asset ${request.asset_code} is not available for deposit`);
  }

  // Validate amount
  const amount = parseFloat(request.amount);
  if (asset.min_amount && amount < asset.min_amount) {
    throw new Error(`Minimum deposit amount is ${asset.min_amount}`);
  }
  if (asset.max_amount && amount > asset.max_amount) {
    throw new Error(`Maximum deposit amount is ${asset.max_amount}`);
  }

  // Validate account
  if (!request.account || !Keypair.isValidPublicKey(request.account)) {
    throw new Error("Invalid Stellar account address");
  }

  return generateInteractiveUrl(request, "deposit");
};

// ============================================================================
// Withdrawal Flow
// ============================================================================

export const initiateWithdrawal = async (
  request: WithdrawRequest
): Promise<InteractiveFlowResponse> => {
  // Validate asset is supported
  const config = getSep24Config();
  const asset = config.assets[request.asset_code];

  if (!asset || !asset.withdrawals_enabled) {
    throw new Error(`Asset ${request.asset_code} is not available for withdrawal`);
  }

  // Validate amount
  const amount = parseFloat(request.amount);
  if (asset.min_amount && amount < asset.min_amount) {
    throw new Error(`Minimum withdrawal amount is ${asset.min_amount}`);
  }
  if (asset.max_amount && amount > asset.max_amount) {
    throw new Error(`Maximum withdrawal amount is ${asset.max_amount}`);
  }

  // Validate account (for withdrawal, this is the source account)
  if (!request.account || !Keypair.isValidPublicKey(request.account)) {
    throw new Error("Invalid Stellar account address");
  }

  return generateInteractiveUrl(request, "withdrawal");
};

// ============================================================================
// Transaction Status
// ============================================================================

export const getTransaction = (id: string): Sep24Transaction | undefined => {
  return transactions.get(id);
};

export const updateTransactionStatus = (
  id: string,
  status: Sep24TransactionStatus,
  message?: string
): Sep24Transaction | undefined => {
  const transaction = transactions.get(id);
  if (!transaction) {
    return undefined;
  }

  transaction.status = status;
  transaction.updated_at = new Date().toISOString();

  if (message) {
    transaction.message = message;
  }

  if (status === "completed") {
    transaction.completed_at = new Date().toISOString();
  }

  transactions.set(id, transaction);
  return transaction;
};

// ============================================================================
// Callback Handlers
// ============================================================================

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

/**
 * Process callback from anchor/wallet
 * This handles success/failure callbacks from the interactive flow
 */
export const processCallback = async (data: CallbackData): Promise<Sep24Transaction | null> => {
  const { transaction_id, status, message, ...extra } = data;
  
  const transaction = transactions.get(transaction_id);
  if (!transaction) {
    console.error(`[SEP-24] Transaction not found: ${transaction_id}`);
    return null;
  }

  // Update transaction with callback data
  transaction.status = status;
  transaction.updated_at = new Date().toISOString();
  transaction.message = message;

  // Apply extra data
  if (extra.amount_in) transaction.amount_in = extra.amount_in;
  if (extra.amount_out) transaction.amount_out = extra.amount_out;
  if (extra.amount_fee) transaction.amount_fee = extra.amount_fee;
  if (extra.asset_in) transaction.asset_in = extra.asset_in;
  if (extra.asset_out) transaction.asset_out = extra.asset_out;
  if (extra.from) transaction.from = extra.from;
  if (extra.to) transaction.to = extra.to;
  if (extra.memo) transaction.memo = extra.memo;

  // Set completion timestamp for terminal states
  if (status === "completed" || status === "failed" || status === "expired") {
    transaction.completed_at = new Date().toISOString();
  }

  transactions.set(transaction_id, transaction);

  console.log(`[SEP-24] Transaction ${transaction_id} updated to status: ${status}`);

  // If there's a webhook callback URL registered, we could trigger it here
  if (transaction.callback) {
    // In production, queue a webhook notification
    console.log(`[SEP-24] Would trigger callback: ${transaction.callback}`);
  }

  return transaction;
};

// ============================================================================
// Fee Calculation
// ============================================================================

export const calculateFee = async (
  assetCode: string,
  amount: string,
  operation: "deposit" | "withdrawal"
): Promise<{ fee: string; fee_details?: { fixed: number; percent: number } }> => {
  const config = getSep24Config();
  const asset = config.assets[assetCode];

  if (!asset) {
    throw new Error(`Asset ${assetCode} not supported`);
  }

  const amountNum = parseFloat(amount);
  let fee = 0;

  if (asset.fee_fixed) {
    fee += asset.fee_fixed;
  }

  if (asset.fee_percent) {
    fee += amountNum * (asset.fee_percent / 100);
  }

  return {
    fee: fee.toFixed(2),
    fee_details: asset.fee_fixed || asset.fee_percent
      ? { fixed: asset.fee_fixed || 0, percent: asset.fee_percent || 0 }
      : undefined,
  };
};

// ============================================================================
// Express Router
// ============================================================================

const sep24Router = Router();

// Rate limiter for SEP-24 endpoints
const sep24Limiter = (() => {
  const rateLimit = require("express-rate-limit");
  return rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: "Too many requests, please try again later" },
  });
})();

// GET /sep24/info
sep24Router.get("/info", async (req: Request, res: Response) => {
  try {
    const info = getSep24Info();
    res.json(info);
  } catch (error) {
    console.error("[SEP-24] Error fetching info:", error);
    res.status(500).json({ error: "Failed to fetch SEP-24 info" });
  }
});

// GET /sep24/fee - calculate fee for deposit/withdrawal
sep24Router.get("/fee", async (req: Request, res: Response) => {
  try {
    const { asset_code, amount, operation } = req.query;

    if (!asset_code || !amount || !operation) {
      return res.status(400).json({
        error: "Missing required parameters: asset_code, amount, operation",
      });
    }

    if (!["deposit", "withdrawal"].includes(operation as string)) {
      return res.status(400).json({
        error: "Operation must be 'deposit' or 'withdrawal'",
      });
    }

    const feeInfo = await calculateFee(
      asset_code as string,
      amount as string,
      operation as "deposit" | "withdrawal"
    );

    res.json({
      asset_code,
      amount,
      operation,
      ...feeInfo,
    });
  } catch (error: any) {
    console.error("[SEP-24] Error calculating fee:", error);
    res.status(400).json({ error: error.message || "Failed to calculate fee" });
  }
});

// POST /sep24/deposit - initiate deposit
sep24Router.post("/deposit", sep24Limiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request: DepositRequest = req.body;

    // Validate required fields
    if (!request.asset_code) {
      return res.status(400).json({ error: "asset_code is required" });
    }
    if (!request.amount) {
      return res.status(400).json({ error: "amount is required" });
    }
    if (!request.account) {
      return res.status(400).json({ error: "account is required" });
    }

    const result = await initiateDeposit(request);
    res.json(result);
  } catch (error: any) {
    console.error("[SEP-24] Error initiating deposit:", error);
    res.status(400).json({ error: error.message || "Failed to initiate deposit" });
  }
});

// POST /sep24/withdraw - initiate withdrawal
sep24Router.post("/withdraw", sep24Limiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request: WithdrawRequest = req.body;

    // Validate required fields
    if (!request.asset_code) {
      return res.status(400).json({ error: "asset_code is required" });
    }
    if (!request.amount) {
      return res.status(400).json({ error: "amount is required" });
    }
    if (!request.account) {
      return res.status(400).json({ error: "account is required" });
    }

    const result = await initiateWithdrawal(request);
    res.json(result);
  } catch (error: any) {
    console.error("[SEP-24] Error initiating withdrawal:", error);
    res.status(400).json({ error: error.message || "Failed to initiate withdrawal" });
  }
});

// GET /sep24/transaction/:id - get transaction status
sep24Router.get("/transaction/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const transaction = getTransaction(id);

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res.json(transaction);
  } catch (error) {
    console.error("[SEP-24] Error fetching transaction:", error);
    res.status(500).json({ error: "Failed to fetch transaction" });
  }
});

// PUT /sep24/transaction/:id - update transaction (for callbacks)
sep24Router.put("/transaction/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, message, ...extra } = req.body;

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    const validStatuses: Sep24TransactionStatus[] = [
      "pending_user_transfer_start",
      "pending_external",
      "pending_anchor",
      "pending_trust",
      "pending_stellar",
      "completed",
      "failed",
      "expired",
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const transaction = updateTransactionStatus(id, status, message);

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res.json(transaction);
  } catch (error) {
    console.error("[SEP-24] Error updating transaction:", error);
    res.status(500).json({ error: "Failed to update transaction" });
  }
});

// POST /sep24/callback/:id - receive callback from anchor/wallet
sep24Router.post("/callback/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const callbackData: CallbackData = req.body;

    // Validate callback contains required fields
    if (!callbackData.transaction_id) {
      callbackData.transaction_id = id;
    }

    if (!callbackData.status) {
      return res.status(400).json({ error: "status is required in callback" });
    }

    const transaction = await processCallback(callbackData);

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Build redirect URL if success/failure URLs are present
    const storedTransaction = transactions.get(id);
    let redirectUrl: string | null = null;

    if (storedTransaction) {
      const baseUrl = req.protocol + "://" + req.get("host");
      
      if (callbackData.status === "completed") {
        // Build success redirect
        redirectUrl = `${baseUrl}/sep24/success?id=${id}`;
      } else if (callbackData.status === "failed" || callbackData.status === "expired") {
        // Build failure redirect
        redirectUrl = `${baseUrl}/sep24/failure?id=${id}`;
      }
    }

    res.json({ 
      success: true, 
      transaction,
      ...(redirectUrl && { redirect: redirectUrl })
    });
  } catch (error) {
    console.error("[SEP-24] Error processing callback:", error);
    res.status(500).json({ error: "Failed to process callback" });
  }
});

// GET /sep24/success - success callback page (for redirect)
sep24Router.get("/success", async (req: Request, res: Response) => {
  const { id } = req.query;
  
  if (!id) {
    return res.status(400).json({ error: "Transaction ID required" });
  }

  const transaction = getTransaction(id as string);
  
  if (!transaction) {
    return res.status(404).json({ error: "Transaction not found" });
  }

  res.json({
    success: true,
    message: "Transaction completed successfully",
    transaction,
  });
});

// GET /sep24/failure - failure callback page (for redirect)
sep24Router.get("/failure", async (req: Request, res: Response) => {
  const { id } = req.query;
  
  if (!id) {
    return res.status(400).json({ error: "Transaction ID required" });
  }

  const transaction = getTransaction(id as string);
  
  if (!transaction) {
    return res.status(404).json({ error: "Transaction not found" });
  }

  res.json({
    success: false,
    message: transaction.message || "Transaction failed",
    transaction,
  });
});

// Health check endpoint
sep24Router.get("/health", async (req: Request, res: Response) => {
  const config = getSep24Config();
  
  res.json({
    status: "ok",
    version: "1.0.0",
    supported_assets: Object.keys(config.assets),
    features: config.features,
  });
});

export default sep24Router;
export {
  getSep24Info,
  initiateDeposit,
  initiateWithdrawal,
  getTransaction,
  updateTransactionStatus,
  processCallback,
  calculateFee,
  getSep24Config,
};
