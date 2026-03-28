import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import { Transaction, Keypair, StrKey } from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase, STELLAR_NETWORKS } from "../config/stellar";
import { Keypair } from "stellar-sdk";

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
}

const transactions = new Map<string, Sep24Transaction>();

// ============================================================================
// Configuration
// ============================================================================

export const getSep24Config = () => ({
  webAuthDomain: process.env.STELLAR_WEB_AUTH_DOMAIN || "https://api.mobilemoney.com",
  interactiveUrlBase: process.env.SEP24_INTERACTIVE_URL || "https://wallet.mobilemoney.com/deposit",
  secretKey: process.env.STELLAR_ISSUER_SECRET || "",
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
  kind: "deposit" | "withdrawal"
): Promise<InteractiveFlowResponse> => {
  const config = getSep24Config();
  const transactionId = uuidv4();

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

  const params = new URLSearchParams({
    transaction_id: transactionId,
    asset_code: request.asset_code,
    amount: request.amount,
    account: request.account,
    lang: request.lang || "en",
  });

  if (request.memo) params.append("memo", request.memo);
  if (request.email) params.append("email", request.email);
  if (request.wallet_name) params.append("wallet_name", request.wallet_name);
  if (request.wallet_url) params.append("wallet_url", request.wallet_url);
  if (request.success_url) params.append("success_url", request.success_url);
  if (request.failure_url) params.append("failure_url", request.failure_url);

  const callbackUrl = `${config.webAuthDomain}/sep24/callback/${transactionId}`;
  params.append("callback", callbackUrl);

  const baseUrl = kind === "deposit" 
    ? config.interactiveUrlBase 
    : config.interactiveUrlBase.replace("deposit", "withdraw");

  return {
    url: `${baseUrl}?${params.toString()}`,
    id: transactionId,
  };
};

export const initiateDeposit = async (request: DepositRequest): Promise<InteractiveFlowResponse> => {
  const config = getSep24Config();
  const asset = config.assets[request.asset_code as keyof typeof config.assets];

  if (!asset || !asset.deposits_enabled) {
    throw new Error(`Asset ${request.asset_code} is not available for deposit`);
  }

  const amount = parseFloat(request.amount);
  if (asset.min_amount && amount < asset.min_amount) {
    throw new Error(`Minimum deposit amount is ${asset.min_amount}`);
  }
  if (asset.max_amount && amount > asset.max_amount) {
    throw new Error(`Maximum deposit amount is ${asset.max_amount}`);
  }

  // Validate account
  if (!request.account || !StrKey.isValidEd25519PublicKey(request.account)) {
    throw new Error("Invalid Stellar account address");
  }
  if (!request.account || !isValidStellarPublicKey(request.account)) throw new Error("Invalid address");
  return generateInteractiveUrl(request, "deposit");
};

export const initiateWithdrawal = async (request: WithdrawRequest): Promise<InteractiveFlowResponse> => {
  const config = getSep24Config();
  const asset = config.assets[request.asset_code as keyof typeof config.assets];

  if (!asset || !asset.withdrawals_enabled) {
    throw new Error(`Asset ${request.asset_code} is not available for withdrawal`);
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
  
    if (!request.account || !isValidStellarPublicKey(request.account)) throw new Error("Invalid address");

  return generateInteractiveUrl(request, "withdrawal");
};

export const getTransaction = (id: string): Sep24Transaction | undefined => transactions.get(id);

export const updateTransactionStatus = (
  id: string,
  status: Sep24TransactionStatus,
  message?: string
): Sep24Transaction | undefined => {
  const transaction = transactions.get(id);
  if (!transaction) return undefined;

  transaction.status = status;
  transaction.updated_at = new Date().toISOString();
  if (message) transaction.message = message;
  if (status === "completed") transaction.completed_at = new Date().toISOString();

  transactions.set(id, transaction);
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

export const processCallback = async (data: CallbackData): Promise<Sep24Transaction | null> => {
  const { transaction_id, status, message, ...extra } = data;
  const transaction = transactions.get(transaction_id);
  if (!transaction) return null;

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
  }

  transactions.set(transaction_id, transaction);
  return transaction;
};

export const calculateFee = async (
  assetCode: string,
  amount: string,
  _operation: "deposit" | "withdrawal"
): Promise<{ fee: string; fee_details?: { fixed: number; percent: number } }> => {
  const config = getSep24Config();
  const asset = config.assets[assetCode as keyof typeof config.assets];

  if (!asset) {
    throw new Error(`Asset ${assetCode} not supported`);
  }

  const amountNum = parseFloat(amount);
  // ERROR FIX: Changed 'let' to 'const' as 'fee' is not reassigned
  const fee = (asset.fee_fixed || 0) + (amountNum * ((asset.fee_percent || 0) / 100));

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

const sep24Limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, please try again later" },
});

sep24Router.get("/info", async (_req: Request, res: Response) => {
  try {
    res.json(getSep24Info());
  } catch (_error) { // Prefixed with _ to satisfy linter
    res.status(500).json({ error: "Failed to fetch SEP-24 info" });
  }
});

sep24Router.get("/fee", async (req: Request, res: Response) => {
  try {
    const { asset_code, amount, operation } = req.query;
    if (!asset_code || !amount || !operation) throw new Error("Missing params");

    const feeInfo = await calculateFee(
      asset_code as string,
      amount as string,
      operation as "deposit" | "withdrawal"
    );

    res.json({ asset_code, amount, operation, ...feeInfo });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

sep24Router.post("/deposit", sep24Limiter, async (req: Request, res: Response) => {
  try {
    const result = await initiateDeposit(req.body);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

sep24Router.post("/withdraw", sep24Limiter, async (req: Request, res: Response) => {
  try {
    const result = await initiateWithdrawal(req.body);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

sep24Router.get("/transaction/:id", async (req: Request, res: Response) => {
  const transaction = getTransaction(req.params.id);
  if (!transaction) return res.status(404).json({ error: "Not found" });
  res.json(transaction);
});

sep24Router.put("/transaction/:id", async (req: Request, res: Response) => {
  const { status, message } = req.body;
  const transaction = updateTransactionStatus(req.params.id, status, message);
  if (!transaction) return res.status(404).json({ error: "Not found" });
  res.json(transaction);
});

sep24Router.post("/callback/:id", async (req: Request, res: Response) => {
  try {
    const callbackData: CallbackData = { ...req.body, transaction_id: req.params.id };
    const transaction = await processCallback(callbackData);
    if (!transaction) return res.status(404).json({ error: "Not found" });

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    let redirectUrl = null;
    if (transaction.status === "completed") redirectUrl = `${baseUrl}/sep24/success?id=${req.params.id}`;
    if (["failed", "expired"].includes(transaction.status)) redirectUrl = `${baseUrl}/sep24/failure?id=${req.params.id}`;

    res.json({ success: true, transaction, ...(redirectUrl && { redirect: redirectUrl }) });
  } catch (_error) { // Prefixed with _ to satisfy linter
    res.status(500).json({ error: "Failed to process callback" });
  }
});

sep24Router.get("/success", async (req: Request, res: Response) => {
  const transaction = getTransaction(req.query.id as string);
  if (!transaction) return res.status(404).json({ error: "Not found" });
  res.json({ success: true, message: "Completed", transaction });
});

sep24Router.get("/failure", async (req: Request, res: Response) => {
  const transaction = getTransaction(req.query.id as string);
  if (!transaction) return res.status(404).json({ error: "Not found" });
  res.json({ success: false, message: transaction.message || "Failed", transaction });
});

sep24Router.get("/health", (_req: Request, res: Response) => {
  const config = getSep24Config();
  res.json({ status: "ok", supported_assets: Object.keys(config.assets) });
});

export default sep24Router;
export { getSep24Config };
