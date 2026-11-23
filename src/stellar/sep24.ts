import logger from "../utils/logger";
import { Router, Request, Response, NextFunction } from "express";
import { sep24RateLimiter } from "../middleware/rateLimit";
import { v4 as uuidv4 } from "uuid";
import { Transaction, Keypair, StrKey, Memo } from "@stellar/stellar-sdk";
import {
  getStellarServer,
  getNetworkPassphrase,
  STELLAR_NETWORKS,
} from "../config/stellar";
import { ERROR_CODES } from "../constants/errorCodes";
import { TransactionModel } from "../models/transaction";
import { createError } from "../middleware/errorHandler";
import { enqueueSepWebhook } from "../services/stellar/webhooks";
import { enqueueCallbackRetry } from "../queue/callbackQueue";
import {
  generateSignedSep24Url,
  verifySep24Signature,
} from "../utils/sep24Signature";
import {
  Sep24MemoType,
  formatSep24ValidationError,
  sep24DepositRequestSchema,
  toStellarMemo,
} from "../validators/sep24";
import {
  PostgresSep24TransactionStore,
  Sep24TransactionStore,
} from "./sep24Store";
import {
  renderSep24InteractivePage,
  renderSep24ExpiredSessionPage,
} from "../services/sep24InteractivePage";
import { getConfigValue } from "../config/appConfig";
import {
  OrangeQrCodeGenerator,
  renderOrangeMoneyQrSection,
} from "../providers/orange/qrCode";

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
  memo_type?: Sep24MemoType;
  stellar_transaction_id?: string;
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
  /** Memo to attach to the Stellar payment, e.g. for a shared exchange address. */
  memo?: string;
  memo_type?: Sep24MemoType;
  email?: string;
  wallet_name?: string;
  wallet_url?: string;
  lang?: string;
  callback?: string;
  success_url?: string;
  failure_url?: string;
  sep9_fields?: Record<string, string>;
  /**
   * Voucher code authorizing a Vodafone Cash Ghana collection instead of a
   * USSD PIN prompt (#1961). Ignored by every other provider.
   */
  voucher_code?: string;
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

let transactionStore: Sep24TransactionStore =
  new PostgresSep24TransactionStore();

/** Swap the persistence backend (used by tests and alternative deployments). */
export const setSep24TransactionStore = (
  store: Sep24TransactionStore,
): void => {
  transactionStore = store;
};

/**
 * Write-through to durable storage. Failures are logged rather than thrown so
 * a database outage does not break the interactive flow.
 */
async function persistTransaction(
  transaction: Sep24Transaction,
): Promise<void> {
  try {
    await transactionStore.save({ ...transaction });
  } catch (error) {
    logger.error(
      { err: error, transactionId: transaction.id },
      "[sep24] Failed to persist transaction",
    );
  }
}

// Token limits: max active interactive transactions per account
const MAX_ACTIVE_TRANSACTIONS_PER_ACCOUNT = 5;
const activeTransactionsPerAccount = new Map<string, number>();

// ============================================================================
// Configuration
// ============================================================================

// Well-known testnet issuers, used as defaults when an env override is not
// set. A mainnet deployment must override these via env vars.
const DEFAULT_TESTNET_USDC_ISSUER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const DEFAULT_TESTNET_EURC_ISSUER =
  "GC5GIOFB4CTFDMYD37EQE7O5D6HKAYD73BXHYEG27KFONBURSTLPQGLD";

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
    } as Sep24Asset,
    USDC: {
      asset_code: "USDC",
      asset_issuer:
        process.env.SEP38_USDC_ISSUER ||
        process.env.STELLAR_ASSET_ISSUER ||
        DEFAULT_TESTNET_USDC_ISSUER,
      sep6_enabled: true,
      deposits_enabled: true,
      withdrawals_enabled: true,
      transfer_server:
        process.env.STELLAR_HORIZON_URL ||
        "https://horizon-testnet.stellar.org",
      sep24_enabled: true,
      min_amount: 1,
      max_amount: 100000,
    } as Sep24Asset,
    EURC: {
      asset_code: "EURC",
      asset_issuer:
        process.env.SEP38_EURC_ISSUER || DEFAULT_TESTNET_EURC_ISSUER,
      sep6_enabled: true,
      deposits_enabled: true,
      withdrawals_enabled: true,
      transfer_server:
        process.env.STELLAR_HORIZON_URL ||
        "https://horizon-testnet.stellar.org",
      sep24_enabled: true,
      min_amount: 1,
      max_amount: 100000,
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
    memo_type: request.memo
      ? ("memo_type" in request && request.memo_type) || "text"
      : undefined,
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

  if ((request as any).token) params.append("token", (request as any).token);
  if ((request as any).session_token)
    params.append("session_token", (request as any).session_token);

  if (request.memo) params.append("memo", request.memo);
  if (transaction.memo_type) params.append("memo_type", transaction.memo_type);
  if (request.email) params.append("email", request.email);
  if (request.wallet_name) params.append("wallet_name", request.wallet_name);
  if (request.wallet_url) params.append("wallet_url", request.wallet_url);
  if (request.success_url) params.append("success_url", request.success_url);
  if (request.failure_url) params.append("failure_url", request.failure_url);
  if ("voucher_code" in request && request.voucher_code) {
    params.append("voucher_code", request.voucher_code);
  }

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

    await persistTransaction(transaction);

    return {
      url: signedUrl,
      id: transactionId,
    };
  } catch (error) {
    // Clean up on failure to sign URL
    transactions.delete(transactionId);
    decrementActiveTransactionCount(request.account);
    throw error;
  }
};

export const initiateDeposit = async (
  input: DepositRequest,
): Promise<InteractiveFlowResponse> => {
  const parsed = sep24DepositRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(formatSep24ValidationError(parsed.error));
  }
  const request = parsed.data as DepositRequest;
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

// ============================================================================
// Interactive session expiry (#2264)
// ============================================================================

/**
 * Only transactions still waiting on the user to complete the interactive
 * flow can "expire" in the SEP-24 sense. Once the off-chain leg has started
 * moving (pending_external/pending_anchor/pending_trust/pending_stellar) or
 * reached a terminal state, the interactive URL is no longer the active
 * surface and expiry no longer applies.
 */
const EXPIRABLE_STATUSES: Sep24TransactionStatus[] = [
  "pending_user_transfer_start",
];

function getInteractiveSessionExpiryMs(): number {
  const minutes = getConfigValue<number>(
    "sep24.interactiveSessionExpiryMinutes",
  );
  return minutes * 60 * 1000;
}

/**
 * Returns true when `transaction` is still in an expirable status and its
 * `created_at` is older than the configured interactive session expiry
 * duration (default 15 minutes).
 */
export function isInteractiveSessionExpired(
  transaction: Sep24Transaction,
  now: Date = new Date(),
): boolean {
  if (!EXPIRABLE_STATUSES.includes(transaction.status)) return false;
  if (!transaction.created_at) return false;

  const createdAtMs = new Date(transaction.created_at).getTime();
  if (Number.isNaN(createdAtMs)) return false;

  return now.getTime() - createdAtMs >= getInteractiveSessionExpiryMs();
}

/**
 * Looks up a transaction and, if its interactive session has expired,
 * lazily transitions it to `expired` before returning it. This is the
 * SEP-24 equivalent of a Redis TTL eviction for this module's in-memory +
 * Postgres-backed store: the record isn't deleted (SEP-24 callers still
 * need to see a terminal `expired` status), but it stops being treated as
 * an active, in-progress session the moment it's next read.
 */
export const getTransaction = (id: string): Sep24Transaction | undefined => {
  const transaction = transactions.get(id);
  if (!transaction) return undefined;

  if (isInteractiveSessionExpired(transaction)) {
    return updateTransactionStatus(
      id,
      "expired",
      "Interactive session expired before the user completed the flow.",
    );
  }

  return transaction;
};

/**
 * Sweeps all in-memory transactions for expired interactive sessions and
 * transitions each to `expired`. Intended to be called on a schedule (see
 * jobs/sep24InteractiveExpirationJob.ts) so a session expires even if no one
 * ever requests it again, mirroring the sweep pattern already used for
 * SEP-38 firm quotes (expireStaleQuotes).
 *
 * Returns the number of sessions transitioned to expired.
 */
export function expireStaleInteractiveSessions(now: Date = new Date()): number {
  let count = 0;
  for (const transaction of transactions.values()) {
    if (isInteractiveSessionExpired(transaction, now)) {
      updateTransactionStatus(
        transaction.id,
        "expired",
        "Interactive session expired before the user completed the flow.",
      );
      count++;
    }
  }
  return count;
}

/**
 * Renews an expired (or about-to-expire) interactive session by minting a
 * fresh transaction + signed interactive URL for the same deposit/withdrawal
 * parameters, then marking the original record `expired` once the new one
 * exists so a reader of the old transaction_id sees a clear trail rather
 * than a silently-reused id.
 *
 * Throws if the original transaction cannot be found.
 */
export async function renewInteractiveSession(
  expiredTransactionId: string,
): Promise<InteractiveFlowResponse> {
  const original = transactions.get(expiredTransactionId);
  if (!original) {
    throw new Error(`Transaction ${expiredTransactionId} not found`);
  }

  const renewed = await generateInteractiveUrl(
    {
      asset_code: original.asset_in || "",
      amount: original.amount_in || "0",
      account: original.account || "",
      memo: original.memo,
      memo_type: original.memo_type,
      callback: original.callback,
    },
    original.kind,
  );

  if (original.status !== "expired") {
    updateTransactionStatus(
      expiredTransactionId,
      "expired",
      `Superseded by renewed session ${renewed.id}.`,
    );
  }

  return renewed;
}

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
  void persistTransaction(transaction);

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

    enqueueCallbackRetry({
      transactionId: transaction.id,
      status,
      callbackUrl: transaction.callback,
      payload: transaction as unknown as Record<string, unknown>,
    }).catch((err) =>
      logger.error(`[sep24-callback] Error enqueuing callback retry:`, err),
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
  void persistTransaction(transaction);

  if (statusChanged && transaction.callback) {
    enqueueSepWebhook(
      transaction.id,
      status,
      transaction.callback,
      transaction,
    ).catch((err) =>
      logger.error(`[sep24-webhook] Error enqueuing webhook:`, err),
    );

    enqueueCallbackRetry({
      transactionId: transaction.id,
      status,
      callbackUrl: transaction.callback,
      payload: transaction as unknown as Record<string, unknown>,
    }).catch((err) =>
      logger.error(`[sep24-callback] Error enqueuing callback retry:`, err),
    );
  }

  return transaction;
};

/**
 * Replaces the in-memory copy of a transaction with a record loaded from
 * durable storage. Used by out-of-band settlement (e.g. bank statement
 * reconciliation) that changes a deposit's state in the database directly.
 */
export const loadTransactionFromStore = (
  transaction: Sep24Transaction,
): Sep24Transaction => {
  transactions.set(transaction.id, transaction);
  return transaction;
};

/** Sends the Stellar payment for a deposit (StellarService in production). */
export interface DepositPaymentSender {
  sendPayment(
    destination: string,
    amount: string,
    senderName?: string,
    receiverName?: string,
    useFeeBump?: boolean,
    memo?: Memo,
  ): Promise<{ hash?: string }>;
}

async function defaultPaymentSender(): Promise<DepositPaymentSender> {
  const { StellarService } =
    await import("../services/stellar/stellarService.js");
  return new StellarService();
}

/**
 * Fulfils a SEP-24 deposit by sending the asset to the wallet's account,
 * attaching the memo the wallet supplied so shared exchange addresses can
 * credit the right customer. Call once the off-chain (mobile money) leg has
 * been received.
 *
 * On a submission error the transaction stays `pending_stellar` and the
 * error is rethrown: the payment may still land, so blindly retrying could
 * pay twice.
 */
export const fulfillDeposit = async (
  id: string,
  sender?: DepositPaymentSender,
  options: { resumePendingStellar?: boolean } = {},
): Promise<Sep24Transaction> => {
  const transaction = transactions.get(id);
  if (!transaction) throw new Error(`Transaction ${id} not found`);
  if (transaction.kind !== "deposit") {
    throw new Error(`Transaction ${id} is not a deposit`);
  }
  if (transaction.status === "completed") return transaction;
  if (transaction.status === "pending_stellar" && !options.resumePendingStellar) {
    throw new Error(`Deposit ${id} is already being submitted`);
  }
  if (["failed", "expired"].includes(transaction.status)) {
    throw new Error(`Deposit ${id} is ${transaction.status}`);
  }

  const amount = transaction.amount_out ?? transaction.amount_in;
  if (!transaction.account || !amount) {
    throw new Error(`Deposit ${id} is missing account or amount`);
  }

  const memo = transaction.memo
    ? toStellarMemo(transaction.memo, transaction.memo_type ?? "text")
    : undefined;

  updateTransactionStatus(id, "pending_stellar");

  let result: { hash?: string };
  try {
    const payer = sender ?? (await defaultPaymentSender());
    result = await payer.sendPayment(
      transaction.account,
      amount,
      undefined,
      undefined,
      false,
      memo,
    );
  } catch (error) {
    transaction.message = `Stellar submission failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await persistTransaction(transaction);
    throw error;
  }

  transaction.stellar_transaction_id = result.hash;
  updateTransactionStatus(id, "completed");
  await persistTransaction(transaction);
  return transaction;
};

export const calculateFee = async (
  assetCode: string,
  amount: string,
  _operation: "deposit" | "withdrawal",
): Promise<{
  fee: string;
  fee_details?: { fixed: number; percent: number };
}> => {
  const config = getSep24Config();
  const asset = config.assets[assetCode as keyof typeof config.assets];

  if (!asset) {
    throw new Error(`Asset ${assetCode} not supported`);
  }

  const amountNum = parseFloat(amount);
  // ERROR FIX: Changed 'let' to 'const' as 'fee' is not reassigned
  const fee =
    (asset.fee_fixed || 0) + amountNum * ((asset.fee_percent || 0) / 100);

  return {
    fee: fee.toFixed(2),
    fee_details:
      asset.fee_fixed || asset.fee_percent
        ? { fixed: asset.fee_fixed || 0, percent: asset.fee_percent || 0 }
        : undefined,
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
    const { asset_code, amount, operation } = req.query;
    if (!asset_code || !amount || !operation) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Missing params", {
        error: "Missing params",
      });
    }

    const feeInfo = await calculateFee(
      asset_code as string,
      amount as string,
      operation as "deposit" | "withdrawal",
    );

    res.json({ asset_code, amount, operation, ...feeInfo });
  } catch (error: any) {
    throw createError(ERROR_CODES.INVALID_INPUT, error.message, {
      error: error.message,
    });
  }
});

// Express 4 does not route async throws to the error handler, so failures
// are passed to next() explicitly.
const depositHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await initiateDeposit(req.body);
    res.json(result);
  } catch (error: any) {
    next(
      createError(ERROR_CODES.INVALID_INPUT, error.message, {
        error: error.message,
      }),
    );
  }
};

const withdrawHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await initiateWithdrawal(req.body);
    res.json(result);
  } catch (error: any) {
    next(
      createError(ERROR_CODES.INVALID_INPUT, error.message, {
        error: error.message,
      }),
    );
  }
};

sep24Router.post("/deposit", sep24Limiter, depositHandler);
sep24Router.post("/withdraw", sep24Limiter, withdrawHandler);

/**
 * GET /sep24/interactive/deposit
 *
 * Renders the SEP-24 interactive deposit page and, when Orange Money
 * scan-to-pay parameters are supplied, embeds a base64 QR code image in the
 * page (#1968).
 *
 * Query params: transaction_id, merchant_id, amount, currency, reference,
 * merchant_name, merchant_city.
 */
sep24Router.get("/interactive/deposit", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const transactionId = req.query.transaction_id
    ? String(req.query.transaction_id)
    : undefined;

  // Accessing an expired interactive URL shows an expiration notice with a
  // renewal option instead of the normal deposit page (#2264). getTransaction
  // lazily transitions the record to "expired" as a side effect of this
  // check, so subsequent reads (polling, admin tooling) see it too.
  if (transactionId) {
    const transaction = getTransaction(transactionId);
    if (transaction && transaction.status === "expired") {
      return res.send(
        renderSep24ExpiredSessionPage({
          transactionId,
          renewUrl: `/sep24/interactive/renew/${transactionId}`,
        }),
      );
    }
  }

  const merchantId = req.query.merchant_id
    ? String(req.query.merchant_id)
    : undefined;
  const amount = req.query.amount ? String(req.query.amount) : undefined;

  if (!merchantId || !amount) {
    return res.send(renderSep24InteractivePage());
  }

  try {
    const generator = new OrangeQrCodeGenerator();
    const qr = await generator.generate({
      merchantId,
      amount,
      currency: req.query.currency ? String(req.query.currency) : undefined,
      reference: req.query.reference
        ? String(req.query.reference)
        : req.query.transaction_id
          ? String(req.query.transaction_id)
          : undefined,
      merchantName: req.query.merchant_name
        ? String(req.query.merchant_name)
        : undefined,
      merchantCity: req.query.merchant_city
        ? String(req.query.merchant_city)
        : undefined,
    });

    return res.send(
      renderSep24InteractivePage({
        qrSectionHtml: renderOrangeMoneyQrSection(qr),
      }),
    );
  } catch (error: any) {
    logger.warn(
      { error: error.message },
      "[SEP-24] Failed to render Orange Money QR section",
    );
    // Never fail the interactive page because of a provider-specific embed.
    return res.send(renderSep24InteractivePage());
  }
});

/**
 * POST /sep24/interactive/renew/:id
 *
 * Renewal endpoint for an expired interactive session (#2264): mints a new
 * transaction + signed interactive URL for the same deposit/withdrawal
 * parameters as the expired one, marks the original record superseded, and
 * redirects the caller to the fresh interactive URL.
 */
sep24Router.post(
  "/interactive/renew/:id",
  sep24Limiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const renewed = await renewInteractiveSession(req.params.id);
      return res.redirect(303, renewed.url);
    } catch (error: any) {
      next(
        createError(ERROR_CODES.NOT_FOUND, error.message, {
          error: error.message,
        }),
      );
    }
  },
);

// Canonical SEP-24 paths.
sep24Router.post(
  "/transactions/deposit/interactive",
  sep24Limiter,
  depositHandler,
);
sep24Router.post(
  "/transactions/withdraw/interactive",
  sep24Limiter,
  withdrawHandler,
);

const transactionModel = new TransactionModel();

sep24Router.get("/transaction", async (req: Request, res: Response) => {
  const { id, stellar_transaction_id, external_transaction_id } = req.query;
  const txId = (id ||
    stellar_transaction_id ||
    external_transaction_id) as string;

  if (!txId) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Missing id", {
      error: "Missing id",
    });
  }

  let transaction = getTransaction(txId);

  if (!transaction) {
    try {
      const dbTx = await transactionModel.findById(txId);
      if (dbTx) {
        let status: string = "pending_external";
        if (dbTx.status === "completed") status = "completed";
        if (
          ["failed", "cancelled", "reversed", "clawed_back"].includes(
            dbTx.status,
          )
        )
          status = "failed";

        transaction = {
          id: dbTx.id,
          kind: dbTx.type === "withdraw" ? "withdrawal" : "deposit",
          status: status as any,
          amount_in: dbTx.amount,
          amount_out: dbTx.amount,
          created_at: dbTx.createdAt.toISOString(),
          completed_at:
            dbTx.status === "completed" && dbTx.updatedAt
              ? dbTx.updatedAt.toISOString()
              : undefined,
          message: dbTx.notes || "Detailed status message",
          more_info_url: `${getSep24Config().webAuthDomain}/tx/${dbTx.id}`,
        };
      }
    } catch (err) {
      // ignore invalid uuid
    }
  }

  if (!transaction) {
    throw createError(ERROR_CODES.NOT_FOUND, "Not found", {
      error: "Not found",
    });
  }

  const formatRFC3339 = (dateStr?: string) => {
    if (!dateStr) return undefined;
    const d = new Date(dateStr);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };

  const response = {
    transaction: {
      id: transaction.id,
      kind: transaction.kind,
      status: transaction.status,
      amount_in: transaction.amount_in,
      amount_out: transaction.amount_out,
      amount_fee: transaction.amount_fee,
      started_at: formatRFC3339(transaction.created_at),
      completed_at: formatRFC3339(transaction.completed_at),
      more_info_url:
        transaction.more_info_url ||
        `${getSep24Config().webAuthDomain}/tx/${transaction.id}`,
      message: transaction.message || "Detailed status message",
    },
  };

  res.json(response);
});

sep24Router.get(
  "/interactive/callback",
  async (req: Request, res: Response, next: NextFunction) => {
    const { sep24RouteHandler } = await import("../routes/sep24.js");
    return sep24RouteHandler(req, res, next);
  },
);

sep24Router.get(
  "/callback/popup",
  async (req: Request, res: Response, next: NextFunction) => {
    const { sep24RouteHandler } = await import("../routes/sep24.js");
    return sep24RouteHandler(req, res, next);
  },
);

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
