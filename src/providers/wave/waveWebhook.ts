import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { TransactionModel, TransactionStatus } from "../../models/transaction";
import { StellarService } from "../../services/stellar/stellarService";
import { withRetry } from "../../services/retry";
import {
  notifyTransactionWebhook,
  WebhookService,
} from "../../services/webhook";
import { ingestRateLimiter } from "../../middleware/ingestRateLimit";
import logger from "../../utils/logger";

const router = Router();
router.use(ingestRateLimiter);

const transactionModel = new TransactionModel();
const stellarService = new StellarService();
const webhookService = new WebhookService();

/**
 * Wave checkout.session.completed event payload (Wave Senegal / Côte
 * d'Ivoire). `client_reference` is the value the merchant supplied when
 * creating the checkout session -- this integration sets it to the
 * internal deposit transaction's reference number, which is how the
 * webhook matches the event back to a transaction.
 */
export interface WaveCheckoutSessionCompletedEvent {
  id: string;
  type: "checkout.session.completed";
  data: {
    id: string;
    client_reference: string;
    payment_status: "succeeded" | "cancelled" | "processing";
    amount: string;
    currency: string;
    transaction_id?: string;
  };
}

/**
 * Verifies Wave's HMAC-SHA256 webhook signature, same scheme as the
 * generic `sha256=` handler in ../../routes/webhooks.ts (Wave signs
 * webhooks with an HMAC-SHA256 over the raw request body, hex-encoded).
 */
export function verifyWaveWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;

  const expectedSignature = signature.startsWith("sha256=")
    ? signature.substring(7)
    : signature;

  const computedSignature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (expectedSignature.length !== computedSignature.length) return false;
  return timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(computedSignature),
  );
}

export async function verifyWaveWebhookRequest(
  req: Request,
  res: Response,
  next: () => void,
) {
  const secret = process.env.WAVE_WEBHOOK_SECRET;
  if (!secret) {
    logger.error("[webhook-wave] WAVE_WEBHOOK_SECRET not configured");
    return res.status(500).json({ error: "Webhook processing not configured" });
  }

  const signatureHeader = req.headers["wave-signature"];
  const signature =
    typeof signatureHeader === "string" ? signatureHeader : undefined;

  const rawPayload = JSON.stringify(req.body);
  if (!verifyWaveWebhookSignature(rawPayload, signature, secret)) {
    logger.warn("[webhook-wave] Invalid or missing signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  next();
}

/**
 * Maps a Wave checkout session's terminal payment_status to the internal
 * TransactionStatus it should drive. `processing` is intentionally
 * excluded: it isn't a terminal state, so the handler acks it without
 * transitioning the transaction (Wave will send a later event once the
 * session actually completes or is cancelled).
 */
function resolveTargetStatus(
  paymentStatus: WaveCheckoutSessionCompletedEvent["data"]["payment_status"],
): TransactionStatus | null {
  switch (paymentStatus) {
    case "succeeded":
      return TransactionStatus.Completed;
    case "cancelled":
      return TransactionStatus.Failed;
    default:
      return null;
  }
}

/**
 * Credits the user's Stellar account for a Wave deposit that has been
 * confirmed complete. Mirrors the Stellar-submission step in
 * ../../queue/worker.ts's processTransaction (retry policy, idempotency
 * via metadata.stellar.transactionHash, status transition to Completed)
 * without re-running that job's mobile-money-side call, since Wave has
 * already confirmed payment via this webhook.
 */
async function creditStellarForCompletedDeposit(
  transactionId: string,
  stellarAddress: string,
  amount: string,
): Promise<void> {
  const transaction = await transactionModel.findById(transactionId);
  const stellarMetadata = transaction?.metadata?.stellar as
    { transactionHash?: string } | undefined;
  const existingHash = stellarMetadata?.transactionHash;

  if (!existingHash) {
    const stellarSubmission = await withRetry(
      () => stellarService.sendPayment(stellarAddress, amount),
      { maxAttempts: 3, baseDelayMs: 500, provider: "wave" },
    );

    await transactionModel.patchMetadata(transactionId, {
      stellar: {
        transactionHash: stellarSubmission.hash,
        submittedAt: (
          stellarSubmission.submittedAt || new Date()
        ).toISOString(),
      },
    });
  }

  await transactionModel.updateStatus(
    transactionId,
    TransactionStatus.Completed,
  );
  await notifyTransactionWebhook(transactionId, "transaction.completed", {
    transactionModel: transactionModel as any,
    webhookService,
  });
}

router.post(
  "/",
  verifyWaveWebhookRequest,
  async (req: Request, res: Response) => {
    try {
      const event = req.body as WaveCheckoutSessionCompletedEvent;

      if (event.type !== "checkout.session.completed") {
        // Not an event this handler is responsible for; ack so Wave doesn't retry.
        return res.status(200).json({ received: true, ignored: true });
      }

      const clientReference = event.data?.client_reference;
      if (!clientReference) {
        return res.status(400).json({ error: "Missing client_reference" });
      }

      const transaction =
        await transactionModel.findByReferenceNumber(clientReference);
      if (!transaction) {
        logger.warn(
          { clientReference },
          "[webhook-wave] No transaction found for client_reference",
        );
        return res.status(404).json({
          error: "Transaction not found",
          client_reference: clientReference,
        });
      }

      const targetStatus = resolveTargetStatus(event.data.payment_status);
      if (targetStatus === null) {
        logger.info(
          {
            transactionId: transaction.id,
            paymentStatus: event.data.payment_status,
          },
          "[webhook-wave] Non-terminal payment_status; no transition applied",
        );
        return res.status(200).json({ received: true, transitioned: false });
      }

      if (targetStatus === TransactionStatus.Failed) {
        await transactionModel.updateStatus(
          transaction.id,
          TransactionStatus.Failed,
        );
        await notifyTransactionWebhook(transaction.id, "transaction.failed", {
          transactionModel: transactionModel as any,
          webhookService,
        });
        return res.status(200).json({
          received: true,
          transaction_id: transaction.id,
          status: TransactionStatus.Failed,
        });
      }

      if (!transaction.stellarAddress) {
        logger.error(
          { transactionId: transaction.id },
          "[webhook-wave] Transaction has no stellarAddress; cannot credit",
        );
        await transactionModel.updateStatus(
          transaction.id,
          TransactionStatus.Failed,
        );
        return res.status(422).json({
          error: "Transaction has no destination Stellar address",
          transaction_id: transaction.id,
        });
      }

      // Atomically claim the transaction before crediting on-chain funds so a
      // retried/duplicate Wave webhook delivery can't trigger a double mint.
      const claimed = await transactionModel.claimForProcessing(transaction.id);
      if (!claimed) {
        const existing = await transactionModel.findById(transaction.id);
        logger.info(
          { transactionId: transaction.id, status: existing?.status },
          "[webhook-wave] Transaction already claimed/processed; skipping duplicate credit",
        );
        return res.status(200).json({
          received: true,
          transaction_id: transaction.id,
          status: existing?.status,
          duplicate: true,
        });
      }

      await creditStellarForCompletedDeposit(
        transaction.id,
        transaction.stellarAddress,
        event.data.amount,
      );

      return res.status(200).json({
        received: true,
        transaction_id: transaction.id,
        status: TransactionStatus.Completed,
      });
    } catch (error) {
      logger.error({ error }, "[webhook-wave] Processing error");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
