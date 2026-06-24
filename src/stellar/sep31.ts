import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { sep31RateLimiter } from "../middleware/rateLimit";
import crypto from "crypto";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { getConfiguredPaymentAsset } from "../services/stellar/assetService";
import  rateLimit from "express-rate-limit";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();
const transactionModel = new TransactionModel();

// --- SEP-31 Status State Machine ---
// Valid statuses per SEP-31 spec
export enum Sep31Status {
  PendingSender = "pending_sender",
  PendingStellar = "pending_stellar",
  PendingReceiver = "pending_receiver",
  PendingExternal = "pending_external",
  Completed = "completed",
  Error = "error",
}

// Valid status transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  [Sep31Status.PendingSender]: [Sep31Status.PendingStellar, Sep31Status.Error],
  [Sep31Status.PendingStellar]: [Sep31Status.PendingReceiver, Sep31Status.PendingExternal, Sep31Status.Completed, Sep31Status.Error],
  [Sep31Status.PendingReceiver]: [Sep31Status.PendingExternal, Sep31Status.Completed, Sep31Status.Error],
  [Sep31Status.PendingExternal]: [Sep31Status.Completed, Sep31Status.Error],
  [Sep31Status.Completed]: [],
  [Sep31Status.Error]: [Sep31Status.PendingStellar, Sep31Status.PendingReceiver],
};

function isValidTransition(from: string, to: string): boolean {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

// Map internal TransactionStatus to SEP-31 status
function mapToSep31Status(status: TransactionStatus, metadata?: Record<string, unknown>): Sep31Status {
  const sep31Meta = (metadata as any)?.sep31;
  if (sep31Meta?.status) return sep31Meta.status as Sep31Status;

  switch (status) {
    case TransactionStatus.Completed: return Sep31Status.Completed;
    case TransactionStatus.Failed: return Sep31Status.Error;
    case TransactionStatus.Cancelled: return Sep31Status.Error;
    default: return Sep31Status.PendingSender;
  }
}

// --- Configuration ---
const SEP31_CONFIG = {
  minAmount: parseFloat(process.env.SEP31_MIN_AMOUNT || "0.1"),
  maxAmount: parseFloat(process.env.SEP31_MAX_AMOUNT || "1000000"),
  feeFixed: parseFloat(process.env.SEP31_FEE_FIXED || "1.00"),
  feePercent: parseFloat(process.env.SEP31_FEE_PERCENT || "0.5"),
  statusEta: parseInt(process.env.SEP31_STATUS_ETA || "600", 10),
  get receivingAccount(): string {
    return process.env.STELLAR_RECEIVING_ACCOUNT || "";
  },
};

// --- Rate Limiters ---
// Read endpoints: higher limit (info lookups, status checks)
const sep31ReadLimiter = process.env.NODE_ENV === "test"
  ? (req: any, res: any, next: any) => next()
  : rateLimit({
      windowMs: 60 * 1000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later." },
    });

// Write endpoints: strict limit (transaction creation)
const sep31WriteLimiter = process.env.NODE_ENV === "test"
  ? (req: any, res: any, next: any) => next()
  : rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later." },
    });

// --- Helpers ---
function getAssetCode(): string {
  const asset = getConfiguredPaymentAsset();
  return asset.isNative() ? "XLM" : asset.getCode();
}

function getAssetString(): string {
  const asset = getConfiguredPaymentAsset();
  return asset.isNative() ? "stellar:native" : `stellar:${asset.getCode()}:${asset.getIssuer()}`;
}

function parseAssetCode(rawCode: string): string {
  if (rawCode.startsWith("stellar:")) {
    const parts = rawCode.split(":");
    return parts[1];
  }
  return rawCode;
}

function calculateFee(amount: number): { fee: number; total: number } {
  let fee = SEP31_CONFIG.feeFixed + (amount * SEP31_CONFIG.feePercent / 100);
  fee = parseFloat(fee.toFixed(7));
  return { fee, total: parseFloat((amount + fee).toFixed(7)) };
}

function generateMemo(): string {
  // Generate a short unique memo (max 28 chars for Stellar text memo)
  return crypto.randomUUID().replace(/-/g, "").substring(0, 28);
}

// Validate UUID format
function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// --- Routes ---

/**
 * GET /info
 *
 * Returns supported assets, fees, required fields, and sender/receiver types
 * per the SEP-31 specification.
 */
router.get("/info", sep31ReadLimiter, async (req: Request, res: Response) => {
  try {
    const assetCode = getAssetCode();

    return res.json({
      receive: {
        [assetCode]: {
          enabled: true,
          fee_fixed: SEP31_CONFIG.feeFixed,
          fee_percent: SEP31_CONFIG.feePercent,
          min_amount: SEP31_CONFIG.minAmount,
          max_amount: SEP31_CONFIG.maxAmount,
          sender_sep12_type: "sep31-sender",
          receiver_sep12_type: "sep31-receiver",
          fields: {
            transaction: {
              receiver_id: {
                description: "The SEP-12 ID of the receiver",
                optional: false,
              },
              sender_id: {
                description: "The SEP-12 ID of the sender",
                optional: false,
              },
              receiver_routing_number: {
                description: "Routing number of the receiver's bank account",
                optional: true,
              },
              receiver_account_number: {
                description: "Account number of the receiver's bank or mobile money account",
                optional: true,
              },
              type: {
                description: "Type of payout: SWIFT, SEPA, or mobile_money",
                optional: true,
              },
            },
          },
        },
      },
    });
  } catch (error: any) {
    logger.error("SEP-31 /info error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

/**
 * POST /transactions
 *
 * Creates a new cross-border payment transaction.
 * Validates amount, asset, sender/receiver fields, and returns
 * the Stellar account + memo for the sender to make payment.
 */
router.post("/transactions", sep31WriteLimiter, async (req: Request, res: Response) => {
  const {
    amount,
    asset_code,
    asset_issuer,
    sender_id,
    receiver_id,
    fields,
    lang,
  } = req.body;

  // --- Input Validation ---
  if (!amount || !asset_code) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Missing required fields: amount, asset_code", {
      error: "invalid_request",
      message: "Missing required fields: amount, asset_code",
    });
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Amount must be a positive number", {
      error: "invalid_request",
      message: "Amount must be a positive number",
    });
  }

  if (parsedAmount < SEP31_CONFIG.minAmount) {
    throw createError(ERROR_CODES.INVALID_INPUT, `Amount below minimum: ${SEP31_CONFIG.minAmount}`, {
      error: "invalid_request",
      message: `Amount below minimum: ${SEP31_CONFIG.minAmount}`,
    });
  }

  if (parsedAmount > SEP31_CONFIG.maxAmount) {
    throw createError(ERROR_CODES.INVALID_INPUT, `Amount above maximum: ${SEP31_CONFIG.maxAmount}`, {
      error: "invalid_request",
      message: `Amount above maximum: ${SEP31_CONFIG.maxAmount}`,
    });
  }

  const cleanAssetCode = parseAssetCode(asset_code);
  const configuredCode = getAssetCode();

  if (cleanAssetCode !== configuredCode) {
    throw createError(ERROR_CODES.INVALID_INPUT, `Asset ${cleanAssetCode} is not supported. Supported: ${configuredCode}`, {
      error: "invalid_request",
      message: `Asset ${cleanAssetCode} is not supported. Supported: ${configuredCode}`,
    });
  }

  // Validate asset_issuer if provided (non-native assets)
  const configuredAsset = getConfiguredPaymentAsset();
  if (asset_issuer && !configuredAsset.isNative()) {
    if (asset_issuer !== configuredAsset.getIssuer()) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Asset issuer does not match configured issuer", {
        error: "invalid_request",
        message: "Asset issuer does not match configured issuer",
      });
    }
  }

  // Extract sender/receiver from top-level or nested fields
  const txFields = fields?.transaction || {};
  const finalSenderId = sender_id || txFields.sender_id;
  const finalReceiverId = receiver_id || txFields.receiver_id;

  if (!finalSenderId || !finalReceiverId) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Missing required fields: sender_id, receiver_id", {
      error: "invalid_request",
      message: "Missing required fields: sender_id, receiver_id",
    });
  }

  if (!SEP31_CONFIG.receivingAccount) {
    logger.error("SEP-31: STELLAR_RECEIVING_ACCOUNT not configured");
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Anchor receiving account not configured", {
      error: "server_error",
      message: "Anchor receiving account not configured",
    });
  }

  try {
    const memo = generateMemo();
    const { fee, total } = calculateFee(parsedAmount);
    const amountOut = parsedAmount; // Amount delivered to receiver (before payout fees)

    // Build sender/receiver payload mapping
    const metadata = {
      sep31: {
        status: Sep31Status.PendingSender,
        sender_id: finalSenderId,
        receiver_id: finalReceiverId,
        receiver_routing_number: txFields.receiver_routing_number || null,
        receiver_account_number: txFields.receiver_account_number || null,
        payout_type: txFields.type || "mobile_money",
        message: txFields.message || null,
        memo,
        memo_type: "text",
        amount_in: total.toString(),
        amount_out: amountOut.toString(),
        amount_fee: fee.toString(),
        asset_code: cleanAssetCode,
        asset_issuer: configuredAsset.isNative() ? null : configuredAsset.getIssuer(),
        lang: lang || "en",
      },
    };

    const newTransaction = await transactionModel.create({
      type: "deposit",
      amount: total.toString(),
      phoneNumber: "SEP-31",
      provider: "stellar-sep31",
      stellarAddress: SEP31_CONFIG.receivingAccount,
      status: TransactionStatus.Pending,
      metadata,
      notes: `SEP-31 cross-border payment from ${finalSenderId} to ${finalReceiverId}`,
    });

    return res.status(201).json({
      id: newTransaction.id,
      status: Sep31Status.PendingSender,
      status_eta: SEP31_CONFIG.statusEta,
      stellar_account_id: SEP31_CONFIG.receivingAccount,
      stellar_memo_type: "text",
      stellar_memo: memo,
      amount_in: total.toString(),
      amount_in_asset: getAssetString(),
      amount_out: amountOut.toString(),
      amount_out_asset: getAssetString(),
      amount_fee: fee.toString(),
      amount_fee_asset: getAssetString(),
    });
  } catch (error: any) {
    logger.error("SEP-31 POST /transactions error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

/**
 * GET /transactions/:id
 *
 * Returns the current status and details of a SEP-31 transaction.
 */
router.get("/transactions/:id", sep31ReadLimiter, async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!isValidUUID(id)) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid transaction ID format", {
      error: "Invalid transaction ID format",
    });
  }

  try {
    const transaction = await transactionModel.findById(id);

    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    // Verify this is a SEP-31 transaction
    const sep31Meta = (transaction.metadata as any)?.sep31;
    if (!sep31Meta) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    const sep31Status = mapToSep31Status(transaction.status, transaction.metadata);
    const assetString = getAssetString();

    return res.json({
      transaction: {
        id: transaction.id,
        status: sep31Status,
        status_eta: sep31Status === Sep31Status.Completed || sep31Status === Sep31Status.Error
          ? null
          : SEP31_CONFIG.statusEta,
        amount_in: sep31Meta.amount_in || transaction.amount,
        amount_in_asset: assetString,
        amount_out: sep31Meta.amount_out || transaction.amount,
        amount_out_asset: assetString,
        amount_fee: sep31Meta.amount_fee || "0",
        amount_fee_asset: assetString,
        stellar_account_id: SEP31_CONFIG.receivingAccount,
        stellar_memo_type: sep31Meta.memo_type || "text",
        stellar_memo: sep31Meta.memo || "",
        stellar_transaction_id: sep31Meta.stellar_transaction_id || null,
        started_at: transaction.createdAt.toISOString(),
        completed_at: sep31Status === Sep31Status.Completed
          ? (transaction.updatedAt || transaction.createdAt).toISOString()
          : null,
        required_info_message: sep31Meta.required_info_message || null,
        required_info_updates: sep31Meta.required_info_updates || null,
        message: sep31Meta.message || null,
        refunded: sep31Meta.refunded || false,
      },
    });
  } catch (error: any) {
    logger.error("SEP-31 GET /transactions/:id error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

/**
 * PATCH /transactions/:id
 *
 * Updates transaction fields (e.g. when the anchor requests additional info).
 * Only allows updates when the transaction is in a pending state.
 */
router.patch("/transactions/:id", sep31WriteLimiter, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { fields } = req.body;

  if (!isValidUUID(id)) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid transaction ID format", {
      error: "Invalid transaction ID format",
    });
  }

  if (!fields || !fields.transaction) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Missing required: fields.transaction", {
      error: "invalid_request",
      message: "Missing required: fields.transaction",
    });
  }

  try {
    const transaction = await transactionModel.findById(id);

    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    const sep31Meta = (transaction.metadata as any)?.sep31;
    if (!sep31Meta) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    const currentStatus = mapToSep31Status(transaction.status, transaction.metadata);

    // Only allow updates on pending transactions
    if (currentStatus === Sep31Status.Completed) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Cannot update a completed transaction", {
        error: "invalid_request",
        message: "Cannot update a completed transaction",
      });
    }

    // Merge updated fields into metadata
    const txFields = fields.transaction;
    const updatedSep31 = {
      ...sep31Meta,
      ...(txFields.receiver_routing_number !== undefined && { receiver_routing_number: txFields.receiver_routing_number }),
      ...(txFields.receiver_account_number !== undefined && { receiver_account_number: txFields.receiver_account_number }),
      ...(txFields.type !== undefined && { payout_type: txFields.type }),
      required_info_message: null,
      required_info_updates: null,
    };

    const updatedMetadata = {
      ...(transaction.metadata as Record<string, unknown>),
      sep31: updatedSep31,
    };

    await transactionModel.updateMetadata(id, updatedMetadata);

    return res.json({ status: "updated" });
  } catch (error: any) {
    logger.error("SEP-31 PATCH /transactions/:id error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

export { SEP31_CONFIG, calculateFee, mapToSep31Status, isValidTransition, VALID_TRANSITIONS };
export default router;
