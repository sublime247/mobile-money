import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { notifyTransactionWebhook, WebhookEvent } from "../services/webhook";

const router = Router();
const transactionModel = new TransactionModel();

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const stellarWebhookSchema = z.object({
  transaction_hash: z.string().min(1),
  status: z.enum(["success", "failed"]),
  ledger: z.number().int().positive().optional(),
  timestamp: z.string(),
  source_account: z.string().optional(),
  destination_account: z.string().optional(),
  amount: z.string().optional(),
});

export type StellarWebhookPayload = z.infer<typeof stellarWebhookSchema>;

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

router.post("/webhook", async (req: RawBodyRequest, res: Response) => {
  const webhookSecret = process.env.STELLAR_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[stellar-webhook] STELLAR_WEBHOOK_SECRET not configured");
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
        webhook_processed_at: new Date().toISOString(),
      });

      const webhookEvent: WebhookEvent =
        newStatus === TransactionStatus.Completed
          ? "transaction.completed"
          : "transaction.failed";

      await notifyTransactionWebhook(transaction.id, webhookEvent, {
        transactionModel,
      });

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
    console.error("[stellar-webhook] Processing error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
