import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { getConfiguredPaymentAsset } from "../services/stellar/assetService";

const router = Router();
const transactionModel = new TransactionModel();

// Strict rate limiter for SEP-31 endpoints
const sep31Limiter = process.env.NODE_ENV === "test" 
  ? (req: any, res: any, next: any) => next()
  : rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 10, // Limit each IP to 10 requests per window (strict)
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: "Too many requests, please try again later.",
      },
    });

/**
 * GET /info
 * 
 * Provides information about the assets the anchor supports for SEP-31.
 */
router.get("/info", sep31Limiter, async (req: Request, res: Response) => {
  const asset = getConfiguredPaymentAsset();
  const assetCode = asset.isNative() ? "XLM" : asset.getCode();

  const info = {
    receive: {
      [assetCode]: {
        enabled: true,
        fee_fixed: 0,
        fee_percent: 0,
        min_amount: 0.1,
        max_amount: 1000000,
        sender_sep12_type: "sep31-sender",
        receiver_sep12_type: "sep31-receiver",
        fields: {
          transaction: {
            receiver_id: {
              description: "The ID of the receiver",
              optional: false,
            },
            sender_id: {
              description: "The ID of the sender",
              optional: false,
            },
            message: {
              description: "Optional message for the receiver",
              optional: true,
            }
          }
        }
      }
    }
  };

  return res.json(info);
});

/**
 * POST /transactions
 * 
 * Creates a new SEP-31 transaction.
 */
router.post("/transactions", sep31Limiter, async (req: Request, res: Response) => {
  const {
    amount,
    asset_code,
    asset_issuer,
    sender_id,
    receiver_id,
    fields,
  } = req.body;

  if (!amount || !asset_code) {
    return res.status(400).json({ error: "Missing required fields: amount, asset_code" });
  }

  // Handle asset_code with potential stellar: prefix
  let cleanAssetCode = asset_code;
  if (asset_code.startsWith("stellar:")) {
    const parts = asset_code.split(":");
    cleanAssetCode = parts[1];
  }

  // Basic validation of fields
  const txFields = fields?.transaction || {};
  const finalSenderId = sender_id || txFields.sender_id;
  const finalReceiverId = receiver_id || txFields.receiver_id;

  if (!finalSenderId || !finalReceiverId) {
    return res.status(400).json({ error: "Missing required transaction fields: sender_id, receiver_id" });
  }

  const asset = getConfiguredPaymentAsset();
  const configuredCode = asset.isNative() ? "XLM" : asset.getCode();

  if (cleanAssetCode !== configuredCode) {
    return res.status(400).json({ error: `Asset ${cleanAssetCode} is not supported.` });
  }

  try {
    const transactionId = crypto.randomUUID();
    
    // Map sender/receiver payload mapping
    const metadata = {
      sep31: {
        sender_id: finalSenderId,
        receiver_id: finalReceiverId,
        message: txFields.message,
      }
    };

    const newTransaction = await transactionModel.create({
      type: "deposit", // SEP-31 receive is like a deposit for the receiver
      amount: amount.toString(),
      phoneNumber: "SEP-31", // Placeholder
      provider: "stellar-sep31",
      stellarAddress: "", // Will be updated
      status: TransactionStatus.Pending,
      metadata,
      notes: `SEP-31 Transaction from ${finalSenderId} to ${finalReceiverId}`,
    });

    // SEP-31 response format
    const memo = newTransaction.id.length <= 28 ? newTransaction.id : newTransaction.id.substring(0, 28);

    return res.status(201).json({
      id: newTransaction.id,
      status: "pending_sender",
      stellar_account_id: process.env.STELLAR_RECEIVING_ACCOUNT || "GABC...", // Anchor's receiving account
      stellar_memo_type: "text",
      stellar_memo: memo,
    });
  } catch (error: any) {
    console.error("Error creating SEP-31 transaction:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /transactions/:id
 * 
 * Retrieves a transaction by ID.
 */
router.get("/transactions/:id", sep31Limiter, async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const transaction = await transactionModel.findById(id);

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Map to SEP-31 status format
    let sep31Status = "pending_sender";
    if (transaction.status === TransactionStatus.Completed) sep31Status = "completed";
    if (transaction.status === TransactionStatus.Failed) sep31Status = "error";

    const asset = getConfiguredPaymentAsset();
    const assetString = asset.isNative() ? "stellar:native" : `stellar:${asset.getCode()}:${asset.getIssuer()}`;

    return res.json({
      transaction: {
        id: transaction.id,
        status: sep31Status,
        status_eta: 600,
        amount_in: transaction.amount,
        amount_in_asset: assetString,
        amount_out: transaction.amount,
        amount_out_asset: assetString,
        amount_fee: "0",
        amount_fee_asset: assetString,
        stellar_account_id: process.env.STELLAR_RECEIVING_ACCOUNT || "GABC...",
        stellar_memo_type: "text",
        stellar_memo: transaction.id.length <= 28 ? transaction.id : transaction.id.substring(0, 28),
        stellar_transaction_id: (transaction.metadata as any)?.stellar_tx_id || "",
        started_at: transaction.createdAt.toISOString(),
        completed_at: transaction.updatedAt ? transaction.updatedAt.toISOString() : null,
      }
    });
  } catch (error: any) {
    console.error("Error fetching SEP-31 transaction:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
