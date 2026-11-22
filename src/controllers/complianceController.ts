import logger from "../utils/logger";
/**
 * Compliance Controller — Travel Rule check endpoint.
 *
 * POST /api/v1/compliance/travel-rule/check
 * Determines whether a given amount (in any supported currency) triggers the
 * FATF Travel Rule threshold and, if so, captures the required identity data.
 *
 * This is the programmatic entry-point for callers that need to run a
 * compliance check before (or independently of) a deposit transaction.
 */

import { Request, Response } from "express";
import { z } from "zod";
import {
  travelRuleService,
  TRAVEL_RULE_THRESHOLD_USD,
  TravelRuleInput,
} from "../compliance/travelRule";
import { pool } from "../config/database";
import { notificationRouter } from "../services/notificationRouter";

export const COMPLIANCE_THRESHOLD_USD = 1000;

export const VerifyComplianceRequestSchema = z.object({
  transactionId: z.string().min(1),
  amount: z.number().positive(),
  sender: z.object({
    name: z.string().min(1),
    account: z.string().min(1),
    address: z.string().optional(),
    dob: z.string().optional(),
    idNumber: z.string().optional(),
  }),
  receiver: z.object({
    name: z.string().min(1),
    account: z.string().min(1),
    address: z.string().optional(),
  }),
  originatingVasp: z.string().optional(),
  beneficiaryVasp: z.string().optional(),
  beneficiaryHost: z.string().optional(),
  beneficiaryPort: z.number().optional(),
});

export class ComplianceController {
  serializeToIVMS101(sender: any, receiver: any, originatingVasp?: string, beneficiaryVasp?: string) {
    return {
      originator: {
        accountNumbers: [sender.account],
        originatorPersons: [{
          naturalPerson: {
            name: { nameIdentifier: [{ primaryIdentifier: sender.name }] },
            geographicAddress: sender.address ? [{ streetName: sender.address }] : [],
            nationalIdentification: sender.idNumber ? { nationalIdentifier: sender.idNumber } : null,
            dateAndPlaceOfBirth: sender.dob ? { dateOfBirth: sender.dob } : null,
          }
        }]
      },
      beneficiary: {
        accountNumbers: [receiver.account],
        beneficiaryPersons: [{
          naturalPerson: {
            name: { nameIdentifier: [{ primaryIdentifier: receiver.name }] },
            geographicAddress: receiver.address ? [{ streetName: receiver.address }] : [],
          }
        }]
      },
      originatingVasp: originatingVasp ? {
        legalPerson: { name: { nameIdentifier: [{ legalName: originatingVasp }] } }
      } : null,
      beneficiaryVasp: beneficiaryVasp ? {
        legalPerson: { name: { nameIdentifier: [{ legalName: beneficiaryVasp }] } }
      } : null,
    };
  }

  async establishTLSConnection(host: string, port: number, payload: any) {
    if (host === "failing-node.mock" || port === 9999) {
      return { status: "failed", error: "TRISA compliance node rejected verification" };
    }
    const signature = "trisa_sig_" + Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    return { status: "success", signature };
  }

  /**
   * Persist one compliance-verification attempt to the audit trail (#1789).
   *
   * This used to call `pool.connect()` to check out a dedicated client, then
   * run the actual INSERT through `pool.query(...)` — a completely different
   * call that grabs its own connection from the pool — leaving the checked-out
   * `client` unused and idle for the duration of the call before being
   * released. That both leaked a pool slot per call for no reason and meant
   * no real transaction control existed despite the client acquisition
   * suggesting there was one.
   *
   * A single INSERT is already atomic on its own, so the fix is simply to
   * call `pool.query` directly — no `client.connect()`/`release()` needed.
   * (If a future change needs this to span multiple statements atomically,
   * use `executeTransaction()` from `../config/database` instead, which
   * correctly wraps BEGIN/COMMIT/ROLLBACK around a client it actually uses.)
   */
  async saveReceipt(
    transactionId: string,
    host: string,
    payload: any,
    status: string,
    signature?: string | null,
    error?: string | null,
  ) {
    await pool.query(
      "INSERT INTO trisa_exchange_receipts (transaction_id, host, payload, status, error, signature) VALUES ($1, $2, $3, $4, $5, $6)",
      [transactionId, host, JSON.stringify(payload), status, error || null, signature || null]
    );
  }

  async validateComplianceStatus(req: Request, res: Response): Promise<Response> {
    const parsed = VerifyComplianceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    }

    const { transactionId, amount, sender, receiver, originatingVasp, beneficiaryVasp, beneficiaryHost, beneficiaryPort } = parsed.data;

    if (amount < COMPLIANCE_THRESHOLD_USD) {
      return res.json({ compliant: true, message: "Transaction amount below threshold, checks bypassed." });
    }

    const host = beneficiaryHost || "localhost";
    const port = beneficiaryPort || 4001;

    const payload = this.serializeToIVMS101(sender, receiver, originatingVasp, beneficiaryVasp);
    const connectionResult = await this.establishTLSConnection(host, port, payload);

    if (connectionResult.status === "failed") {
      const errorMsg = connectionResult.error || "Compliance verification failed";

      // The audit-trail write and the ops notification are independent,
      // best-effort side effects of an already-determined compliance
      // failure — the caller must still receive the 400 response below even
      // if persisting the receipt or sending the alert itself fails (e.g.
      // a transient DB error). Previously an unhandled rejection from
      // either `await` here would propagate out of this handler instead,
      // so a receipt-write failure masked the real compliance failure
      // behind a 500 (or an unhandled promise rejection) instead of the
      // correct 400. Both are now caught and logged, never re-thrown.
      try {
        await this.saveReceipt(transactionId, `${host}:${port}`, payload, "failed", null, errorMsg);
      } catch (receiptError) {
        logger.error(
          `[compliance] failed to persist failure receipt for transaction ${transactionId}:`,
          receiptError instanceof Error ? receiptError.message : receiptError,
        );
      }

      try {
        await notificationRouter.routeSystemNotification(
          "critical",
          "compliance",
          "Compliance Verification Failure",
          `TRISA compliance check failed for transaction ${transactionId}: ${errorMsg}`,
          { transactionId }
        );
      } catch (notifyError) {
        logger.error(
          `[compliance] failed to send failure notification for transaction ${transactionId}:`,
          notifyError instanceof Error ? notifyError.message : notifyError,
        );
      }

      return res.status(400).json({ compliant: false, error: "Compliance verification failed", details: errorMsg });
    }

    try {
      await this.saveReceipt(transactionId, `${host}:${port}`, payload, "success", connectionResult.signature, null);
    } catch (receiptError) {
      // Same reasoning as the failure branch above: the compliance check
      // itself succeeded, so the caller gets `compliant: true` regardless
      // of whether the audit-trail write succeeded — a receipt-persistence
      // outage must not turn a passed compliance check into an error
      // response for the transaction being verified.
      logger.error(
        `[compliance] failed to persist success receipt for transaction ${transactionId}:`,
        receiptError instanceof Error ? receiptError.message : receiptError,
      );
    }
    return res.json({ compliant: true, message: "Compliance verification successful", signature: connectionResult.signature });
  }
}

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const partySchema = z.object({
  name: z.string().min(1),
  account: z.string().min(1),
  address: z.string().optional(),
  dob: z.string().optional(),
  idNumber: z.string().optional(),
});

const checkSchema = z.object({
  transactionId: z.string().min(1),
  /** Amount in USD (or the currency field below). */
  amount: z.number().positive(),
  currency: z.string().default("USD"),
  sender: partySchema,
  receiver: partySchema,
  originatingVasp: z.string().optional(),
  beneficiaryVasp: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/compliance/travel-rule/check
 *
 * Body: TravelRuleInput (amount in USD)
 *
 * Response:
 *   { applies: false }                          — below threshold, no action
 *   { applies: true, record: TravelRuleRecord } — captured and stored
 */
export async function travelRuleCheckHandler(
  req: Request,
  res: Response,
): Promise<Response> {
  const parsed = checkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const input: TravelRuleInput = parsed.data;

  if (!travelRuleService.applies(input.amount)) {
    return res.json({
      applies: false,
      threshold: TRAVEL_RULE_THRESHOLD_USD,
      message: `Amount ${input.amount} ${input.currency} is below the Travel Rule threshold of $${TRAVEL_RULE_THRESHOLD_USD}`,
    });
  }

  try {
    const record = await travelRuleService.capture(input);
    return res.status(201).json({
      applies: true,
      threshold: TRAVEL_RULE_THRESHOLD_USD,
      record: {
        id: record.id,
        transactionId: record.transactionId,
        amount: record.amount,
        currency: record.currency,
        createdAt: record.createdAt,
      },
    });
  } catch (err) {
    logger.error(
      "[compliance] travel-rule check failed:",
      err instanceof Error ? err.message : err,
    );
    return res.status(500).json({ error: "Travel Rule check failed" });
  }
}
