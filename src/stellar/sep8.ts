import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import * as StellarSdk from "stellar-sdk";
import { Pool } from "pg";
import { Sep12Service, Sep12CustomerStatus } from "./sep12";
import {
  sanctionService,
  SanctionScreeningError,
} from "../services/sanctionService";
import { getNetworkPassphrase } from "../config/stellar";

/**
 * SEP-08: Regulated Assets
 *
 * Implements the approval server component of SEP-08, which lets a bridge/anchor
 * gate regulated-asset transactions behind KYC and sanctions checks. Clients submit
 * an unsigned (or partially-signed) transaction XDR; the server validates the
 * submitter, and on success adds the bridge's authorization signature and returns
 * the envelope for the client to submit to Horizon.
 *
 * Specification: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md
 */

// ============================================================================
// Types
// ============================================================================

export type Sep8Status =
  | "success"
  | "revised"
  | "pending"
  | "action_required"
  | "rejected";

export interface Sep8SuccessResponse {
  status: "success" | "revised";
  tx: string;
  message: string;
}

export interface Sep8PendingResponse {
  status: "pending";
  timeout: number;
  message: string;
}

export interface Sep8ActionRequiredResponse {
  status: "action_required";
  message: string;
  action_url: string;
  action_method: "GET" | "POST";
  action_fields: string[];
}

export interface Sep8RejectedResponse {
  status: "rejected";
  error: string;
}

export type Sep8Response =
  | Sep8SuccessResponse
  | Sep8PendingResponse
  | Sep8ActionRequiredResponse
  | Sep8RejectedResponse;

// ============================================================================
// Config
// ============================================================================

export interface Sep8Config {
  signingKey: string;
  networkPassphrase: string;
  kycActionUrl: string;
}

export function getSep8Config(): Sep8Config {
  const signingKey =
    process.env.STELLAR_SIGNING_KEY || process.env.STELLAR_ISSUER_SECRET;
  if (!signingKey) {
    throw new Error(
      "STELLAR_SIGNING_KEY or STELLAR_ISSUER_SECRET must be defined for SEP-08",
    );
  }

  return {
    signingKey,
    networkPassphrase: getNetworkPassphrase(),
    kycActionUrl:
      process.env.SEP8_KYC_ACTION_URL ||
      `${process.env.STELLAR_TRANSFER_SERVER || "https://api.mobilemoney.com"}/sep12`,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract unique (sender, receiver) address pairs from payment-like operations
 * in the transaction so each can be screened for sanctions.
 */
function extractPaymentPairs(
  transaction: StellarSdk.Transaction,
  sourceAccount: string,
): Array<{ sender: string; receiver: string }> {
  const pairs: Array<{ sender: string; receiver: string }> = [];

  for (const op of transaction.operations) {
    const opSource = (op as any).source ?? sourceAccount;

    if (op.type === "payment") {
      pairs.push({
        sender: opSource,
        receiver: (op as StellarSdk.Operation.Payment).destination,
      });
    } else if (op.type === "pathPaymentStrictSend") {
      pairs.push({
        sender: opSource,
        receiver: (op as StellarSdk.Operation.PathPaymentStrictSend)
          .destination,
      });
    } else if (op.type === "pathPaymentStrictReceive") {
      pairs.push({
        sender: opSource,
        receiver: (op as StellarSdk.Operation.PathPaymentStrictReceive)
          .destination,
      });
    }
  }

  // If the transaction contains no payment operations, screen the source account alone.
  if (pairs.length === 0) {
    pairs.push({ sender: sourceAccount, receiver: sourceAccount });
  }

  return pairs;
}

// ============================================================================
// Router
// ============================================================================

export const createSep8Router = (db: Pool): Router => {
  const sep8Router = Router();
  const sep12Service = new Sep12Service(db);

  /**
   * POST /tx_approve
   *
   * Request body (application/json or application/x-www-form-urlencoded):
   *   tx  - base64-encoded XDR of the transaction to approve
   *
   * Returns one of the five SEP-08 response shapes:
   *   success          - signed transaction ready for submission
   *   revised          - transaction was modified then signed
   *   pending          - awaiting async KYC review
   *   action_required  - client must complete KYC before retrying
   *   rejected         - transaction cannot be approved
   */
  sep8Router.post("/tx_approve", async (req: Request, res: Response) => {
    try {
      const { tx } = req.body as { tx?: string };

      if (!tx) {
        return res.status(400).json({
          status: "rejected",
          error: "Missing required parameter: tx",
        } satisfies Sep8RejectedResponse);
      }

      // Load server config — fail fast if env is misconfigured.
      let config: Sep8Config;
      try {
        config = getSep8Config();
      } catch (err: any) {
        logger.error(err, "[SEP-8] Server configuration error:");
        return res.status(500).json({
          status: "rejected",
          error: "Internal server configuration error",
        } satisfies Sep8RejectedResponse);
      }

      // Parse the transaction XDR.
      let transaction: StellarSdk.Transaction;
      try {
        transaction = new StellarSdk.Transaction(tx, config.networkPassphrase);
      } catch {
        return res.status(400).json({
          status: "rejected",
          error: "Invalid transaction: could not parse XDR",
        } satisfies Sep8RejectedResponse);
      }

      const sourceAccount = transaction.source;

      if (!StellarSdk.StrKey.isValidEd25519PublicKey(sourceAccount)) {
        return res.status(400).json({
          status: "rejected",
          error: "Transaction source is not a valid Stellar public key",
        } satisfies Sep8RejectedResponse);
      }

      // KYC check: the source account must be a verified customer.
      let customer: Awaited<ReturnType<typeof sep12Service.getCustomer>>;
      try {
        customer = await sep12Service.getCustomer(
          sourceAccount,
          undefined,
          undefined,
        );
      } catch (err: any) {
        logger.error(err, "[SEP-8] KYC lookup failed:");
        return res.status(500).json({
          status: "rejected",
          error: "Internal server error during KYC check",
        } satisfies Sep8RejectedResponse);
      }

      if (
        customer.status === Sep12CustomerStatus.NEEDS_INFO ||
        customer.status === Sep12CustomerStatus.REJECTED
      ) {
        return res.json({
          status: "action_required",
          message:
            "Complete KYC verification before transacting with this regulated asset.",
          action_url: config.kycActionUrl,
          action_method: "GET",
          action_fields: [
            "first_name",
            "last_name",
            "email_address",
            "id_type",
            "id_number",
          ],
        } satisfies Sep8ActionRequiredResponse);
      }

      if (customer.status === Sep12CustomerStatus.PROCESSING) {
        return res.json({
          status: "pending",
          timeout: 3600,
          message:
            "Your KYC verification is under review. Please try again later.",
        } satisfies Sep8PendingResponse);
      }

      // Sanctions screening: check source and all payment destinations.
      const pairs = extractPaymentPairs(transaction, sourceAccount);
      try {
        for (const { sender, receiver } of pairs) {
          await sanctionService.checkPartiesByAddress(sender, receiver);
        }
      } catch (err) {
        if (err instanceof SanctionScreeningError) {
          return res.json({
            status: "rejected",
            error: "Transaction rejected: account is on a sanctions list",
          } satisfies Sep8RejectedResponse);
        }
        logger.error(err, "[SEP-8] Sanctions check error:");
        return res.status(500).json({
          status: "rejected",
          error: "Internal server error during sanctions check",
        } satisfies Sep8RejectedResponse);
      }

      // All checks passed — add the bridge's authorization signature.
      const signingKeypair = StellarSdk.Keypair.fromSecret(config.signingKey);
      transaction.sign(signingKeypair);

      return res.json({
        status: "success",
        tx: transaction.toEnvelope().toXDR("base64"),
        message: "Transaction approved.",
      } satisfies Sep8SuccessResponse);
    } catch (err: any) {
      logger.error(err, "[SEP-8 /tx_approve]:");
      return res.status(500).json({
        status: "rejected",
        error: "Internal Server Error",
      } satisfies Sep8RejectedResponse);
    }
  });

  return sep8Router;
};

export default createSep8Router;
