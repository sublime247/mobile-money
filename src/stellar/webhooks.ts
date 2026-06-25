import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual, verify, createPublicKey } from "crypto";
import { Keypair } from "stellar-sdk";
import { z } from "zod";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { notifyTransactionWebhook, WebhookEvent } from "../services/webhook";
import { enqueueSepWebhook } from "../services/stellar/webhooks";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";

const router = Router();
const transactionModel = new TransactionModel();

// Rate-limit ingest traffic before signature verification and DB writes.
router.use(ingestRateLimiter);

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const memoSchema = z.union([
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("id"), value: z.string() }),
  z.object({ type: z.literal("hash"), value: z.string() }),
]);

const stellarWebhookSchema = z.object({
  transaction_hash: z.string().min(1),
  status: z.enum(["success", "failed"]),
  ledger: z.number().int().positive().optional(),
  timestamp: z.string(),
  source_account: z.string().optional(),
  destination_account: z.string().optional(),
  amount: z.string().optional(),
  memo: memoSchema.optional(),
});

export type StellarWebhookPayload = z.infer<typeof stellarWebhookSchema>;

/** Extract a plain string reference from any memo type. */
function parseMemoValue(memo: z.infer<typeof memoSchema>): string {
  return memo.value;
}

function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;

  if (signature.startsWith("ed25519=")) {
    const expectedSignature = signature.substring(8);
    try {
      if (secret.startsWith("G") && secret.length === 56) {
        const kp = Keypair.fromPublicKey(secret);
        return kp.verify(Buffer.from(payload), Buffer.from(expectedSignature, "hex"));
      } else {
        const key = createPublicKey(secret);
        return verify(null, Buffer.from(payload), key, Buffer.from(expectedSignature, "hex"));
      }
    } catch (e) {
      return false;
    }
  }

  if (signature.startsWith("sha256=")) {
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

  return false;
}

router.post("/webhook", async (req: RawBodyRequest, res: Response) => {
  const webhookSecret = process.env.STELLAR_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.error("[stellar-webhook] STELLAR_WEBHOOK_SECRET not configured");
    return res.status(500).json({ error: "Webhook processing not configured" });
  }

  const signature = req.headers["x-stellar-signature"] as string | undefined;
  const rawPayload = req.rawBody?.toString() ?? JSON.stringify(req.body);

  if (!verifyWebhookSignature(rawPayload, signature, webhookSecret)) {
    console.warn("[stellar-webhook] Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const parseResult = stellarWebhookSchema.safeParse(req.body);
  if (!parseResult.success) {
    console.warn("[stellar-webhook] Validation failed", parseResult.error.issues);
    return res.status(400).json({
      error: "Validation failed",
      details: parseResult.error.issues,
    });
  }

  const payload = parseResult.data;

  const newStatus =
    payload.status === "success"
      ? TransactionStatus.Completed
      : TransactionStatus.Failed;

  try {
    let transactions = await transactionModel.findByMetadata({
      stellar_hash: payload.transaction_hash,
    });

    // Fall back to memo-based lookup if no match by hash
    if (transactions.length === 0 && payload.memo) {
      const memoValue = parseMemoValue(payload.memo);
      const tx = await transactionModel.findByReferenceNumber(memoValue);
      transactions = tx ? [tx] : [];

      if (transactions.length === 0) {
        transactions = await transactionModel.findByMetadata({
          memo: memoValue,
        });
      }
    }

    if (transactions.length === 0) {
      console.warn(
        `[stellar-webhook] No transaction found for hash ${payload.transaction_hash}`,
      );
      return res.status(404).json({
        error: "Transaction not found",
        hash: payload.transaction_hash,
      });
    }

    let updated = 0;

    for (const transaction of transactions) {
      if (
        transaction.status === TransactionStatus.Completed ||
        transaction.status === TransactionStatus.Failed
      ) {
        console.log(
          `[stellar-webhook] Skipping transaction ${transaction.id} - already in terminal state ${transaction.status}`,
        );
        continue;
      }

      await transactionModel.updateStatus(transaction.id, newStatus);

      await transactionModel.patchMetadata(transaction.id, {
        stellar_ledger: payload.ledger,
        stellar_hash: payload.transaction_hash,
        webhook_processed_at: new Date().toISOString(),
      });

      const webhookEvent: WebhookEvent =
        newStatus === TransactionStatus.Completed
          ? "transaction.completed"
          : "transaction.failed";

      await notifyTransactionWebhook(transaction.id, webhookEvent, {
        transactionModel,
      });

      // SEP-31 Webhook Integration
      const sep31Meta = (transaction.metadata as any)?.sep31;
      if (sep31Meta) {
        const newSep31Status = newStatus === TransactionStatus.Completed ? "completed" : "failed";
        const callbackUrl = sep31Meta.callback || process.env.SEP31_WEBHOOK_URL || process.env.WEBHOOK_URL;
        if (callbackUrl) {
          await enqueueSepWebhook(
            transaction.id,
            newSep31Status,
            callbackUrl,
            {
              id: transaction.id,
              status: newSep31Status,
              amount: transaction.amount,
              stellar_transaction_id: payload.transaction_hash,
              started_at: transaction.createdAt,
              completed_at: new Date().toISOString(),
              stellar_memo: sep31Meta.memo,
              stellar_memo_type: sep31Meta.memo_type,
            }
          ).catch((err) =>
            logger.error(`[sep31-webhook] Error enqueuing webhook:`, err)
          );
        }
      }

      console.log(
        `[stellar-webhook] Updated transaction ${transaction.id} to ${newStatus}`,
      );

      updated++;
    }

    return res.status(200).json({
      success: true,
      updated,
    });
  } catch (error) {
    logger.error("[stellar-webhook] Processing error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
