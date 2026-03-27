import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { TransactionModel, TransactionStatus } from "../models/transaction";

const router = Router();
const transactionModel = new TransactionModel();

/**
 * Stellar webhook payload format expected from external monitoring systems.
 * The transaction_hash should match the stellar_hash stored in transaction metadata.
 */
export interface StellarWebhookPayload {
  transaction_hash: string;
  status: "success" | "failed";
  ledger?: number;
  timestamp: string;
  source_account?: string;
  destination_account?: string;
  amount?: string;
}

function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature = signature.substring(7);
  const computedSignature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (expectedSignature.length !== computedSignature.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(computedSignature),
  );
}

function mapWebhookStatusToTransactionStatus(
  webhookStatus: string,
): TransactionStatus | null {
  switch (webhookStatus) {
    case "success":
      return TransactionStatus.Completed;
    case "failed":
      return TransactionStatus.Failed;
    default:
      return null;
  }
}

router.post("/webhook", async (req: Request, res: Response) => {
  const webhookSecret = process.env.STELLAR_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[stellar-webhook] STELLAR_WEBHOOK_SECRET not configured");
    return res.status(500).json({ error: "Webhook processing not configured" });
  }

  const signature = req.headers["x-stellar-signature"] as string | undefined;
  const rawPayload = JSON.stringify(req.body);

  if (!verifyWebhookSignature(rawPayload, signature, webhookSecret)) {
    console.warn("[stellar-webhook] Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const payload = req.body as StellarWebhookPayload;

  if (!payload.transaction_hash || !payload.status) {
    console.warn("[stellar-webhook] Missing required fields", payload);
    return res.status(400).json({ error: "Missing required fields" });
  }

  const newStatus = mapWebhookStatusToTransactionStatus(payload.status);
  if (!newStatus) {
    console.warn("[stellar-webhook] Unknown status", payload.status);
    return res.status(400).json({ error: "Unknown status" });
  }

  try {
    const transactions = await transactionModel.findByMetadata({
      stellar_hash: payload.transaction_hash,
    });

    if (transactions.length === 0) {
      console.warn(
        `[stellar-webhook] No transaction found for hash ${payload.transaction_hash}`,
      );
      return res.status(404).json({
        error: "Transaction not found",
        hash: payload.transaction_hash,
      });
    }

    for (const transaction of transactions) {
      await transactionModel.updateStatus(transaction.id, newStatus);

      await transactionModel.patchMetadata(transaction.id, {
        stellar_ledger: payload.ledger,
        webhook_processed_at: new Date().toISOString(),
      });

      console.log(
        `[stellar-webhook] Updated transaction ${transaction.id} to ${newStatus}`,
      );
    }

    return res.status(200).json({
      success: true,
      updated: transactions.length,
    });
  } catch (error) {
    console.error("[stellar-webhook] Processing error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
