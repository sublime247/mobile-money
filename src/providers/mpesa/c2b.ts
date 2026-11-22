/**
 * M-Pesa Customer-to-Business (C2B) validation & confirmation URLs (#1966).
 *
 * Safaricom's C2B API lets a customer pay a Paybill or Buy-Goods till directly
 * from their phone. Two HTTPS URLs must be registered with Safaricom:
 *
 *   1. **Validation URL** — called *before* money moves. We validate the
 *      incoming MSISDN, bill reference (`BillRefNumber`) and amount, and
 *      return `ResultCode 0` to accept or a `C2Bxxxxx` code to reject.
 *   2. **Confirmation URL** — called *after* money moves. We credit the
 *      customer, trigger automated on-chain settlement, and acknowledge with
 *      `ResultCode 0`.
 *
 * Both endpoints must answer within a few seconds, so the confirmation handler
 * does its work behind an injected credit/settlement hook and always returns
 * HTTP 200 with a `ResultCode` body (Safaricom's contract).
 */

import { Router, Request, Response } from "express";
import logger from "../../utils/logger";
import { ingestRateLimiter } from "../../middleware/ingestRateLimit";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Raw C2B payload Safaricom POSTs to the validation/confirmation URLs. */
export interface MpesaC2BPayload {
  TransactionType?: string;
  TransID: string;
  TransTime?: string;
  TransAmount: string | number;
  BusinessShortCode?: string;
  BillRefNumber?: string;
  InvoiceNumber?: string;
  OrgAccountBalance?: string;
  ThirdPartyTransID?: string;
  MSISDN: string;
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
  [key: string]: unknown;
}

/** A merchant/customer bill reference registered for C2B collection. */
export interface MpesaBillReference {
  /** Human-entered bill reference, e.g. an invoice or account number. */
  reference: string;
  /** Internal user id that owns the reference. */
  userId: string;
  /** Stellar address that receives the on-chain settlement. */
  stellarAddress?: string;
  currency?: string;
  /** Inactive references are rejected during validation. */
  active?: boolean;
  metadata?: Record<string, unknown>;
}

export interface MpesaC2BNormalized {
  msisdn: string;
  amount: number;
  billRefNumber: string;
}

export interface MpesaC2BValidationOutcome {
  accepted: boolean;
  resultCode: string;
  resultDesc: string;
  errors: string[];
  reference?: MpesaBillReference;
  normalized: MpesaC2BNormalized;
}

export interface MpesaC2BSettlementResult {
  triggered: boolean;
  hash?: string;
  reason?: string;
}

export interface MpesaC2BCreditResult {
  transactionId: string;
  referenceNumber: string;
}

export interface MpesaC2BConfirmationOutcome {
  accepted: boolean;
  duplicate: boolean;
  resultCode: string;
  resultDesc: string;
  transactionId?: string;
  settlement?: MpesaC2BSettlementResult;
}

export interface MpesaC2BCreditInput {
  userId: string;
  amount: number;
  currency: string;
  msisdn: string;
  transId: string;
  billRefNumber: string;
  stellarAddress?: string;
  reference?: MpesaBillReference;
}

export interface MpesaC2BSettlementInput {
  userId: string;
  amount: number;
  currency: string;
  stellarAddress?: string;
  transactionId: string;
  referenceNumber: string;
  transId: string;
}

export interface MpesaC2BServiceOptions {
  /** Configured Paybill/till number; mismatches are rejected when set. */
  businessShortCode?: string;
  /** Override the account-crediting side effect (defaults to ledger + tx). */
  creditAccount?: (input: MpesaC2BCreditInput) => Promise<MpesaC2BCreditResult>;
  /** Override the on-chain settlement trigger (defaults to Stellar payout). */
  settleOnChain?: (
    input: MpesaC2BSettlementInput,
  ) => Promise<MpesaC2BSettlementResult>;
  /** Seed bill references, e.g. loaded from the database at boot. */
  billReferences?: MpesaBillReference[];
}

// ─── Result codes ───────────────────────────────────────────────────────────

export const MPESA_C2B_SUCCESS = {
  ResultCode: "0",
  ResultDesc: "Success",
} as const;

const MPESA_C2B_VALIDATION_ACCEPTED = {
  ResultCode: "0",
  ResultDesc: "Accepted",
} as const;

/** Safaricom C2B rejection codes. */
export const MPESA_C2B_ERROR_CODES = {
  invalidMsisdn: "C2B00011",
  invalidAccount: "C2B00012",
  invalidAmount: "C2B00013",
  invalidShortcode: "C2B00015",
  generic: "C2B00016",
} as const;

const RESULT_DESCRIPTIONS: Record<string, string> = {
  [MPESA_C2B_ERROR_CODES.invalidMsisdn]: "Invalid MSISDN",
  [MPESA_C2B_ERROR_CODES.invalidAccount]: "Invalid Account Number",
  [MPESA_C2B_ERROR_CODES.invalidAmount]: "Invalid Amount",
  [MPESA_C2B_ERROR_CODES.invalidShortcode]: "Invalid Business Short Code",
  [MPESA_C2B_ERROR_CODES.generic]: "Request could not be processed",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize a Kenyan MSISDN to Safaricom's `2547XXXXXXXX` / `2541XXXXXXXX`
 * form. Returns `null` when the number cannot be a Safaricom mobile number.
 */
export function normalizeMsisdn(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const digits = String(value).replace(/\D/g, "");

  if (/^254[17]\d{8}$/.test(digits)) return digits;
  // 07XXXXXXXX / 01XXXXXXXX (local Kenyan format)
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  // 7XXXXXXXX / 1XXXXXXXX (9-digit subscriber number)
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;

  return null;
}

/** Normalize a bill reference for case/format-insensitive matching. */
export function normalizeBillReference(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ─── Service ────────────────────────────────────────────────────────────────

export class MpesaC2BService {
  private readonly businessShortCode?: string;
  private readonly creditAccount: (
    input: MpesaC2BCreditInput,
  ) => Promise<MpesaC2BCreditResult>;
  private readonly settleOnChain: (
    input: MpesaC2BSettlementInput,
  ) => Promise<MpesaC2BSettlementResult>;

  /** normalized reference -> bill reference */
  private readonly billReferences = new Map<string, MpesaBillReference>();
  /** TransID -> confirmation receipt (idempotency guard). */
  private readonly processedTransIds = new Map<
    string,
    { transactionId: string; processedAt: string }
  >();

  constructor(options: MpesaC2BServiceOptions = {}) {
    this.businessShortCode =
      options.businessShortCode ?? process.env.MPESA_SHORTCODE ?? undefined;
    this.creditAccount = options.creditAccount ?? ((input) => this.defaultCredit(input));
    this.settleOnChain =
      options.settleOnChain ?? ((input) => this.defaultSettle(input));

    for (const reference of options.billReferences ?? []) {
      this.registerBillReference(reference);
    }
  }

  // ─── Bill references ────────────────────────────────────────────────────

  /** Register (or replace) a bill reference that C2B payments can target. */
  registerBillReference(reference: MpesaBillReference): void {
    const key = normalizeBillReference(reference.reference);
    if (!key) {
      throw new Error("Bill reference must contain at least one alphanumeric character");
    }
    this.billReferences.set(key, { ...reference, active: reference.active ?? true });
  }

  registerBillReferences(references: MpesaBillReference[]): void {
    for (const reference of references) {
      this.registerBillReference(reference);
    }
  }

  /** Resolve a bill reference, honouring deactivation. */
  resolveBillReference(billRefNumber: unknown): MpesaBillReference | undefined {
    const key = normalizeBillReference(billRefNumber);
    if (!key) return undefined;
    const reference = this.billReferences.get(key);
    if (!reference || reference.active === false) return undefined;
    return reference;
  }

  getRegisteredBillReferences(): MpesaBillReference[] {
    return Array.from(this.billReferences.values());
  }

  clearBillReferences(): void {
    this.billReferences.clear();
  }

  isTransIdProcessed(transId: string): boolean {
    return this.processedTransIds.has(transId);
  }

  // ─── Validation ─────────────────────────────────────────────────────────

  /**
   * Validate an incoming C2B payment. Returns `accepted: false` plus the
   * Safaricom rejection code when any check fails.
   */
  validate(payload: MpesaC2BPayload): MpesaC2BValidationOutcome {
    const errors: string[] = [];
    const msisdn = normalizeMsisdn(payload?.MSISDN);
    const billRefNumber = normalizeBillReference(payload?.BillRefNumber);
    const amount = Number(payload?.TransAmount);

    if (!msisdn) {
      errors.push("Invalid MSISDN");
      return this.rejection(
        MPESA_C2B_ERROR_CODES.invalidMsisdn,
        { msisdn: String(payload?.MSISDN ?? ""), amount, billRefNumber },
        errors,
      );
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push("Invalid transaction amount");
      return this.rejection(
        MPESA_C2B_ERROR_CODES.invalidAmount,
        { msisdn, amount, billRefNumber },
        errors,
      );
    }

    if (!billRefNumber) {
      errors.push("Missing bill reference");
      return this.rejection(
        MPESA_C2B_ERROR_CODES.invalidAccount,
        { msisdn, amount, billRefNumber },
        errors,
      );
    }

    if (
      this.businessShortCode &&
      payload?.BusinessShortCode !== undefined &&
      String(payload.BusinessShortCode) !== String(this.businessShortCode)
    ) {
      errors.push("Business short code mismatch");
      return this.rejection(
        MPESA_C2B_ERROR_CODES.invalidShortcode,
        { msisdn, amount, billRefNumber },
        errors,
      );
    }

    const reference = this.resolveBillReference(billRefNumber);
    if (!reference) {
      errors.push("Bill reference is not registered or is inactive");
      return this.rejection(
        MPESA_C2B_ERROR_CODES.invalidAccount,
        { msisdn, amount, billRefNumber },
        errors,
      );
    }

    return {
      accepted: true,
      resultCode: MPESA_C2B_VALIDATION_ACCEPTED.ResultCode,
      resultDesc: MPESA_C2B_VALIDATION_ACCEPTED.ResultDesc,
      errors: [],
      reference,
      normalized: { msisdn, amount, billRefNumber },
    };
  }

  /** Build the JSON body for the validation URL response. */
  buildValidationResponse(outcome: MpesaC2BValidationOutcome): {
    ResultCode: string;
    ResultDesc: string;
  } {
    return { ResultCode: outcome.resultCode, ResultDesc: outcome.resultDesc };
  }

  /** Convenience wrapper used by the validation route. */
  handleValidation(payload: MpesaC2BPayload): MpesaC2BValidationOutcome {
    try {
      return this.validate(payload);
    } catch (error) {
      logger.error({ error }, "[MpesaC2B] Validation failed unexpectedly");
      return this.rejection(
        MPESA_C2B_ERROR_CODES.generic,
        { msisdn: "", amount: NaN, billRefNumber: "" },
        ["Unexpected validation error"],
      );
    }
  }

  // ─── Confirmation ───────────────────────────────────────────────────────

  /**
   * Confirm an incoming C2B payment: re-validate, then credit the customer and
   * trigger automated on-chain settlement. Duplicate `TransID`s are
   * acknowledged without crediting twice.
   */
  async confirm(
    payload: MpesaC2BPayload,
  ): Promise<MpesaC2BConfirmationOutcome> {
    const validation = this.validate(payload);
    if (!validation.accepted) {
      return {
        accepted: false,
        duplicate: false,
        resultCode: validation.resultCode,
        resultDesc: validation.resultDesc,
      };
    }

    const reference = validation.reference!;
    const { msisdn, amount, billRefNumber } = validation.normalized;

    const existing = this.processedTransIds.get(payload.TransID);
    if (existing) {
      return {
        accepted: true,
        duplicate: true,
        resultCode: MPESA_C2B_SUCCESS.ResultCode,
        resultDesc: MPESA_C2B_SUCCESS.ResultDesc,
        transactionId: existing.transactionId,
      };
    }

    const currency = reference.currency ?? "KES";

    const credit = await this.creditAccount({
      userId: reference.userId,
      amount,
      currency,
      msisdn,
      transId: payload.TransID,
      billRefNumber,
      stellarAddress: reference.stellarAddress,
      reference,
    });

    let settlement: MpesaC2BSettlementResult;
    try {
      settlement = await this.settleOnChain({
        userId: reference.userId,
        amount,
        currency,
        stellarAddress: reference.stellarAddress,
        transactionId: credit.transactionId,
        referenceNumber: credit.referenceNumber,
        transId: payload.TransID,
      });
    } catch (error) {
      // Crediting already succeeded; a settlement failure must not cause
      // Safaricom to retry the confirmation and double-credit the customer.
      logger.error(
        { error, transId: payload.TransID },
        "[MpesaC2B] On-chain settlement trigger failed",
      );
      settlement = { triggered: false, reason: "settlement error" };
    }

    this.processedTransIds.set(payload.TransID, {
      transactionId: credit.transactionId,
      processedAt: new Date().toISOString(),
    });

    logger.info(
      {
        transId: payload.TransID,
        userId: reference.userId,
        amount,
        billRefNumber,
        transactionId: credit.transactionId,
        settlementTriggered: settlement.triggered,
      },
      "[MpesaC2B] Payment confirmed and credited",
    );

    return {
      accepted: true,
      duplicate: false,
      resultCode: MPESA_C2B_SUCCESS.ResultCode,
      resultDesc: MPESA_C2B_SUCCESS.ResultDesc,
      transactionId: credit.transactionId,
      settlement,
    };
  }

  /** Build the JSON body for the confirmation URL response. */
  buildConfirmationResponse(outcome: MpesaC2BConfirmationOutcome): {
    ResultCode: string;
    ResultDesc: string;
  } {
    return { ResultCode: outcome.resultCode, ResultDesc: outcome.resultDesc };
  }

  /** Convenience wrapper used by the confirmation route. */
  async handleConfirmation(
    payload: MpesaC2BPayload,
  ): Promise<MpesaC2BConfirmationOutcome> {
    try {
      return await this.confirm(payload);
    } catch (error) {
      logger.error({ error }, "[MpesaC2B] Confirmation failed unexpectedly");
      return {
        accepted: false,
        duplicate: false,
        resultCode: MPESA_C2B_ERROR_CODES.generic,
        resultDesc: RESULT_DESCRIPTIONS[MPESA_C2B_ERROR_CODES.generic],
      };
    }
  }

  /** Clear idempotency state (tests / replay tooling). */
  resetProcessedTransIds(): void {
    this.processedTransIds.clear();
  }

  // ─── Default side effects ───────────────────────────────────────────────

  private rejection(
    code: string,
    normalized: MpesaC2BNormalized,
    errors: string[],
  ): MpesaC2BValidationOutcome {
    logger.warn(
      { code, errors, msisdn: normalized.msisdn },
      "[MpesaC2B] Payment rejected during validation",
    );
    return {
      accepted: false,
      resultCode: code,
      resultDesc: RESULT_DESCRIPTIONS[code] ?? "Request rejected",
      errors,
      normalized,
    };
  }

  private async defaultCredit(
    input: MpesaC2BCreditInput,
  ): Promise<MpesaC2BCreditResult> {
    const { TransactionModel, TransactionStatus } = await import(
      "../../models/transaction.js"
    );
    const { ledgerService } = await import("../../services/ledgerService.js");

    const model = new TransactionModel();
    const transaction = await model.create({
      type: "deposit",
      amount: input.amount,
      phoneNumber: input.msisdn,
      provider: "mpesa",
      stellarAddress: input.stellarAddress ?? null,
      status: TransactionStatus.Completed,
      userId: input.userId,
      currency: input.currency,
      providerReference: input.transId,
      notes: `M-Pesa C2B payment ${input.transId} (bill ref ${input.billRefNumber})`,
      metadata: {
        mpesaC2B: {
          transId: input.transId,
          billRefNumber: input.billRefNumber,
          msisdn: input.msisdn,
        },
      },
    });

    if (!transaction) {
      throw new Error("Failed to create transaction for M-Pesa C2B payment");
    }

    await ledgerService.postDepositWithCurrency(
      input.amount,
      0,
      (input.currency as never) ?? "KES",
      transaction.referenceNumber,
      transaction.id,
      input.userId,
    );

    return {
      transactionId: transaction.id,
      referenceNumber: transaction.referenceNumber,
    };
  }

  private async defaultSettle(
    input: MpesaC2BSettlementInput,
  ): Promise<MpesaC2BSettlementResult> {
    if (!input.stellarAddress) {
      return {
        triggered: false,
        reason: "bill reference has no destination Stellar address",
      };
    }

    const { StellarService } = await import(
      "../../services/stellar/stellarService.js"
    );
    const stellarService = new StellarService();
    const result = await stellarService.sendPayment(
      input.stellarAddress,
      String(input.amount),
    );

    return { triggered: true, hash: result.hash };
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

/**
 * Express router exposing the Safaricom C2B validation and confirmation URLs.
 * Mount at `/api/mpesa/c2b`.
 */
export function createMpesaC2BRouter(
  service: MpesaC2BService = new MpesaC2BService(),
): Router {
  const router = Router();

  // Safaricom posts sensitive payloads; reuse the ingest limiter.
  router.use(ingestRateLimiter);

  router.post("/validation", (req: Request, res: Response) => {
    const outcome = service.handleValidation(req.body as MpesaC2BPayload);
    return res.status(200).json(service.buildValidationResponse(outcome));
  });

  router.post("/confirmation", async (req: Request, res: Response) => {
    const outcome = await service.handleConfirmation(
      req.body as MpesaC2BPayload,
    );
    return res.status(200).json(service.buildConfirmationResponse(outcome));
  });

  return router;
}

export const mpesaC2BService = new MpesaC2BService();
