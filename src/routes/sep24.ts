import { Router, Request, Response, NextFunction } from "express";
import {
  generateInteractiveUrl,
  initiateDeposit,
  initiateWithdrawal,
  getTransaction,
  updateTransactionStatus,
  processCallback,
  calculateFee,
  getSep24Info,
  Sep24TransactionStatus,
} from "../stellar/sep24";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import logger from "../utils/logger";

export const sep24RouteHandler = Router();

/**
 * GET /sep24/interactive/callback
 * Popup & Webview Callback URL handler for SEP-24 interactive deposit flows (#1944).
 * 
 * Updates transaction status to `pending_user_transfer_start`, handles post-message
 * to parent window/webview, and executes optional redirect URL.
 */
sep24RouteHandler.get(
  "/interactive/callback",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transactionId = (req.query.transaction_id || req.query.id) as string;
      const sessionToken = (req.query.session_token || req.query.token || "") as string;
      const targetOrigin = (req.query.post_message_origin || "*") as string;
      const redirectUrl = (req.query.redirect_url || req.query.success_url || "") as string;
      const requestedStatus = (req.query.status as Sep24TransactionStatus) || "pending_user_transfer_start";

      if (!transactionId) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "Missing required transaction_id query parameter",
        );
      }

      const transaction = getTransaction(transactionId);
      if (!transaction) {
        throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found");
      }

      // Update transaction state to pending_user_transfer_start as per SEP-24 interactive spec
      const updatedTx = updateTransactionStatus(transactionId, requestedStatus);

      logger.info(
        { transactionId, status: requestedStatus, hasSessionToken: Boolean(sessionToken) },
        "[sep24-popup-callback] Interactive deposit callback processed",
      );

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const htmlResponse = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SEP-24 Interactive Deposit Callback</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f9fafb; color: #111827; }
    .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
    .status { color: #059669; font-weight: bold; margin-bottom: 0.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status">✓ Deposit Initiated</div>
    <p>Returning control to your wallet application...</p>
  </div>
  <script>
    (function() {
      var payload = {
        type: "sep24_callback",
        event: "deposit_initiated",
        transaction_id: "${transactionId}",
        status: "${requestedStatus}",
        session_token: "${sessionToken}"
      };
      if (window.opener) {
        try { window.opener.postMessage(payload, "${targetOrigin}"); } catch (e) {}
      }
      if (window.parent && window.parent !== window) {
        try { window.parent.postMessage(payload, "${targetOrigin}"); } catch (e) {}
      }
      ${
        redirectUrl
          ? `setTimeout(function() { window.location.href = "${redirectUrl}"; }, 500);`
          : `setTimeout(function() { if (window.opener) { window.close(); } }, 1500);`
      }
    })();
  </script>
</body>
</html>`;

      return res.send(htmlResponse);
    } catch (err) {
      next(err);
    }
  },
);

export default sep24RouteHandler;
