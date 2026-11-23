/**
 * Safaricom M-Pesa callback routes: STK push (#1969) and B2C payout (#1957).
 *
 * Safaricom POSTs the result of a Lipa Na M-Pesa Online (STK push) request
 * here. When a callback arrives the STK query polling fallback armed by
 * {@link MpesaStkQueryWorker.onStkPushInitiated} is cancelled so the poller
 * never races the callback.
 *
 * The transaction-status update itself is owned by the deposit pipeline that
 * initiated the push; this route only acknowledges and un-arms the poller.
 *
 * B2C (Business to Customer) disbursements are different: there is no
 * existing pipeline that owns the terminal status update the way STK's
 * deposit flow does, so the `/b2c/result` and `/b2c/timeout` routes below
 * both parse Safaricom's callback and update the ledger transaction
 * directly, looked up by the `ConversationID` Safaricom echoes back (stored
 * as `providerReference` on the transaction when `sendB2CPayment` initiates
 * the payout).
 */
import { recordUssdPushOutcome } from "../monitoring/metrics";
import { resolveMpesaStkResult } from "../services/providers/mpesaStkQuery";
import { Router, Request, Response } from "express";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";
import logger from "../utils/logger";
import {
  MPESA_CALLBACK_ACK,
  MpesaB2CResultBody,
  MpesaB2CTimeoutBody,
  MpesaStkCallbackBody,
} from "../services/providers/mpesaService";
import { MpesaProvider } from "../services/providers/mpesaService";
import { mpesaStkQueryWorker } from "../workers/mpesaStkQueryWorker";
import { TransactionModel, TransactionStatus } from "../models/transaction";

import { verifyMpesaCallbackRequest } from "../providers/mpesa/callbackVerification";

const router = Router();
const mpesaProvider = new MpesaProvider();
const transactionModel = new TransactionModel();

router.use(ingestRateLimiter);
// Verify the X.509/RSA signature, timestamp freshness, and initiator password
// before any callback body is parsed into ledger side effects.
router.use(verifyMpesaCallbackRequest);

router.post("/stk/callback", (req: Request, res: Response) => {
  try {
    const result = MpesaProvider.processStkCallback(
      req.body as MpesaStkCallbackBody,
    );

    logger.info(
      {
        event: "mpesa.stk.callback.received",
        checkoutRequestId: result.checkoutRequestId,
        resultCode: result.resultCode,
        success: result.success,
      },
      "M-Pesa STK push callback received",
    );

    // The callback won the race — cancel the 30s query fallback.
    if (result.checkoutRequestId) {
      mpesaStkQueryWorker.onStkCallback(result.checkoutRequestId);
      const resolution = resolveMpesaStkResult(result.resultCode);
      recordUssdPushOutcome(
        "mpesa",
        "KE",
        result.checkoutRequestId,
        result.success
          ? "success"
          : resolution.status === "expired"
            ? "timeout"
            : "failed",
      );
    }

    // Safaricom requires this exact acknowledgement body.
    return res.status(200).json(MPESA_CALLBACK_ACK);
  } catch (error: any) {
    logger.error(
      { event: "mpesa.stk.callback.error", error: error.message },
      "M-Pesa STK callback processing failed",
    );
    return res.status(200).json(MPESA_CALLBACK_ACK);
  }
});

/** Finds and finalises the ledger transaction for a parsed B2C outcome. */
async function finalizeB2COutcome(outcome: {
  status: "completed" | "failed";
  conversationId: string;
  originatorConversationId: string;
  resultCode: number;
  resultDesc: string;
}): Promise<void> {
  const transaction =
    (await transactionModel.findByProviderReference(outcome.conversationId)) ??
    (await transactionModel.findByProviderReference(
      outcome.originatorConversationId,
    ));

  if (!transaction) {
    logger.warn(
      {
        event: "mpesa.b2c.callback.transaction_not_found",
        conversationId: outcome.conversationId,
        originatorConversationId: outcome.originatorConversationId,
      },
      "M-Pesa B2C callback did not match any known transaction",
    );
    return;
  }

  const newStatus =
    outcome.status === "completed"
      ? TransactionStatus.Completed
      : TransactionStatus.Failed;

  await transactionModel.updateStatus(transaction.id, newStatus);

  logger.info(
    {
      event: "mpesa.b2c.callback.finalized",
      transactionId: transaction.id,
      conversationId: outcome.conversationId,
      resultCode: outcome.resultCode,
      status: newStatus,
    },
    "M-Pesa B2C payout finalized from callback",
  );
}

router.post("/b2c/result", async (req: Request, res: Response) => {
  try {
    const outcome = MpesaProvider.processB2CResult(
      req.body as MpesaB2CResultBody,
    );

    logger.info(
      {
        event: "mpesa.b2c.result.received",
        conversationId: outcome.conversationId,
        resultCode: outcome.resultCode,
        status: outcome.status,
      },
      "M-Pesa B2C result callback received",
    );

    await finalizeB2COutcome(outcome);

    // Safaricom requires this exact acknowledgement body.
    return res.status(200).json(MPESA_CALLBACK_ACK);
  } catch (error: any) {
    logger.error(
      { event: "mpesa.b2c.result.error", error: error.message },
      "M-Pesa B2C result callback processing failed",
    );
    return res.status(200).json(MPESA_CALLBACK_ACK);
  }
});

router.post("/b2c/timeout", async (req: Request, res: Response) => {
  try {
    const outcome = MpesaProvider.processB2CTimeout(
      req.body as MpesaB2CTimeoutBody,
    );

    logger.warn(
      {
        event: "mpesa.b2c.timeout.received",
        conversationId: outcome.conversationId,
        resultCode: outcome.resultCode,
      },
      "M-Pesa B2C queue timeout callback received",
    );

    await finalizeB2COutcome(outcome);

    return res.status(200).json(MPESA_CALLBACK_ACK);
  } catch (error: any) {
    logger.error(
      { event: "mpesa.b2c.timeout.error", error: error.message },
      "M-Pesa B2C timeout callback processing failed",
    );
    return res.status(200).json(MPESA_CALLBACK_ACK);
  }
});

/** B2B (Business to Business) callback routes (#2272) */
router.post("/b2b/result", async (req: Request, res: Response) => {
  try {
    const outcome = MpesaProvider.processB2CResult(
      req.body as MpesaB2CResultBody,
    );

    logger.info(
      {
        event: "mpesa.b2b.result.received",
        conversationId: outcome.conversationId,
        resultCode: outcome.resultCode,
        status: outcome.status,
      },
      "M-Pesa B2B result callback received",
    );

    await finalizeB2COutcome(outcome);
    return res.status(200).json(MPESA_CALLBACK_ACK);
  } catch (error: any) {
    logger.error(
      { event: "mpesa.b2b.result.error", error: error.message },
      "M-Pesa B2B result callback processing failed",
    );
    return res.status(200).json(MPESA_CALLBACK_ACK);
  }
});

router.post("/b2b/timeout", async (req: Request, res: Response) => {
  try {
    const outcome = MpesaProvider.processB2CTimeout(
      req.body as MpesaB2CTimeoutBody,
    );

    logger.warn(
      {
        event: "mpesa.b2b.timeout.received",
        conversationId: outcome.conversationId,
        resultCode: outcome.resultCode,
      },
      "M-Pesa B2B queue timeout callback received",
    );

    await finalizeB2COutcome(outcome);
    return res.status(200).json(MPESA_CALLBACK_ACK);
  } catch (error: any) {
    logger.error(
      { event: "mpesa.b2b.timeout.error", error: error.message },
      "M-Pesa B2B timeout callback processing failed",
    );
    return res.status(200).json(MPESA_CALLBACK_ACK);
  }
});

export default router;
