import axios, { AxiosError } from "axios";
import crypto from "crypto";
import logger from "../../utils/logger";
import { maskPII } from "../../utils/masking";
import {
  MobileMoneyProvider,
  ProviderTransactionStatus,
} from "../../services/mobilemoney/mobileMoneyService";
import { resolveEcoCashErrorFromResponse } from "../../services/providers/errors/ecocashErrorMatrix";

/**
 * Econet EcoCash disbursement adapter for Zimbabwe (USD / ZWL wallets) --
 * #1960. Authenticates with the EcoCash merchant gateway using RSA
 * private-key request signing (same signing scheme as
 * ../../services/mobilemoney/providers/moov.ts's signPayload/verifyResponse,
 * adapted from XML/SOAP to EcoCash's JSON REST payloads), submits a
 * subscriber disbursement, and exposes a transaction-status check so the
 * caller can update the database once EcoCash reports a terminal state.
 */

export type EcoCashWallet = "USD" | "ZWL";

export interface EcoCashDisbursementResult {
  success: boolean;
  data?: {
    transactionId: string;
    resultCode: string;
    resultDesc: string;
  };
  error?: string;
  providerErrorCode?: string;
  retryable?: boolean;
}

interface EcoCashAdapterConfig {
  privateKey?: string;
  merchantCode?: string;
  merchantPin?: string;
  baseUrl?: string;
  disbursePath?: string;
  statusPath?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Builds the canonical string EcoCash's merchant gateway expects to be
 * RSA-signed: pipe-delimited fields in a fixed order. Exported so tests can
 * assert against it directly without duplicating the concatenation logic.
 */
export function buildSigningPayload(fields: {
  merchantCode: string;
  reference: string;
  msisdn: string;
  amount: string;
  wallet: EcoCashWallet;
  timestamp: string;
}): string {
  return [
    fields.merchantCode,
    fields.reference,
    fields.msisdn,
    fields.amount,
    fields.wallet,
    fields.timestamp,
  ].join("|");
}

/** Signs a payload string with the merchant's RSA private key (SHA256). */
export function signPayload(payload: string, privateKey: string): string {
  if (!privateKey) {
    throw new Error("EcoCash Adapter: private key is missing");
  }
  const sign = crypto.createSign("SHA256");
  sign.update(payload);
  return sign.sign(privateKey.trim(), "base64");
}

function isSupportedSubscriber(phoneNumber: string): boolean {
  const digits = phoneNumber.replace(/\D/g, "");
  // Zimbabwe: +263, followed by a 9-digit subscriber number.
  return /^263\d{9}$/.test(digits);
}

function normalizeSubscriber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "");
  return digits.startsWith("263") ? digits : `263${digits}`;
}

export class EcoCashAdapter implements MobileMoneyProvider {
  private readonly privateKey: string;
  private readonly merchantCode: string;
  private readonly merchantPin: string;
  private readonly baseUrl: string;
  private readonly disbursePath: string;
  private readonly statusPath: string;
  private readonly timeoutMs: number;

  constructor(config: EcoCashAdapterConfig = {}) {
    this.privateKey =
      config.privateKey ?? process.env.ECOCASH_PRIVATE_KEY ?? "";
    this.merchantCode =
      config.merchantCode ?? process.env.ECOCASH_MERCHANT_CODE ?? "";
    this.merchantPin =
      config.merchantPin ?? process.env.ECOCASH_MERCHANT_PIN ?? "";
    this.baseUrl =
      config.baseUrl ??
      process.env.ECOCASH_BASE_URL ??
      "https://api.ecocash.co.zw/merchant";
    this.disbursePath =
      config.disbursePath ??
      process.env.ECOCASH_DISBURSE_PATH ??
      "/v1/disburse";
    this.statusPath =
      config.statusPath ?? process.env.ECOCASH_STATUS_PATH ?? "/v1/status";
    this.timeoutMs =
      config.timeoutMs ??
      (Number(process.env.ECOCASH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  }

  private joinUrl(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  /**
   * Submits a subscriber disbursement (payout/cash-out). `wallet` selects
   * the USD or ZWL EcoCash wallet the funds are drawn from; the interface
   * this implements (`MobileMoneyProvider.sendPayout`) doesn't have a wallet
   * parameter, so it defaults to USD -- call `disburse` directly when a ZWL
   * payout is needed.
   */
  async disburse(
    phoneNumber: string,
    amount: string,
    wallet: EcoCashWallet = "USD",
    requestId?: string,
  ): Promise<EcoCashDisbursementResult> {
    const reference = requestId || `ecocash-disburse-${Date.now()}`;
    const log = logger.child({ requestId: reference });
    log.info(
      maskPII({ phoneNumber, amount, wallet }),
      "EcoCash: Submitting disbursement",
    );

    if (!isSupportedSubscriber(phoneNumber)) {
      const errorMsg =
        "EcoCash disbursement only supports Zimbabwe (+263) subscriber numbers";
      log.error({ phoneNumber }, errorMsg);
      return { success: false, error: errorMsg, retryable: false };
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      const errorMsg = "Disbursement amount must be a positive number";
      log.error({ amount }, errorMsg);
      return { success: false, error: errorMsg, retryable: false };
    }

    if (!this.merchantCode || !this.merchantPin) {
      const errorMsg =
        "EcoCash Adapter: merchant credentials are not configured";
      log.error(errorMsg);
      return { success: false, error: errorMsg, retryable: false };
    }

    const msisdn = normalizeSubscriber(phoneNumber);
    const timestamp = new Date().toISOString();
    const signature = signPayload(
      buildSigningPayload({
        merchantCode: this.merchantCode,
        reference,
        msisdn,
        amount: String(numericAmount),
        wallet,
        timestamp,
      }),
      this.privateKey,
    );

    try {
      const response = await axios.post(
        this.joinUrl(this.disbursePath),
        {
          merchantCode: this.merchantCode,
          merchantPin: this.merchantPin,
          reference,
          msisdn,
          amount: numericAmount,
          wallet,
          timestamp,
          signature,
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: this.timeoutMs,
        },
      );

      const body = response.data as {
        transactionId?: string;
        resultCode?: string;
        resultDesc?: string;
      };

      log.info(
        maskPII({
          transactionId: body.transactionId,
          resultCode: body.resultCode,
        }),
        "EcoCash: Disbursement submitted",
      );

      return {
        success: true,
        data: {
          transactionId: body.transactionId ?? reference,
          resultCode: body.resultCode ?? "PENDING",
          resultDesc: body.resultDesc ?? "Disbursement accepted",
        },
      };
    } catch (error: unknown) {
      const statusCode =
        error instanceof AxiosError ? error.response?.status : undefined;
      const responseBody =
        error instanceof AxiosError
          ? (error.response?.data as Record<string, unknown> | undefined)
          : undefined;
      const resultCode = responseBody?.resultCode as string | undefined;

      const mapped = resolveEcoCashErrorFromResponse(resultCode, statusCode);

      log.error(
        maskPII({ statusCode, resultCode, mappedErrorCode: mapped?.errorCode }),
        "EcoCash: Disbursement failed",
      );

      return {
        success: false,
        error: mapped?.message ?? "EcoCash disbursement request failed",
        providerErrorCode: resultCode,
        retryable: mapped?.retryable ?? false,
      };
    }
  }

  // ── MobileMoneyProvider interface ────────────────────────────────────────

  /**
   * EcoCash is disbursement/cash-out only in this adapter's current scope
   * (#1960's acceptance criteria cover payouts, not collections); a
   * requestPayment implementation is required by MobileMoneyProvider, so
   * this reports the not-yet-supported condition explicitly rather than
   * silently no-op'ing.
   */
  async requestPayment(): Promise<{
    success: boolean;
    data?: unknown;
    error?: unknown;
  }> {
    return {
      success: false,
      error:
        "EcoCash collection (requestPayment) is not implemented; use disburse() for payouts",
    };
  }

  async sendPayout(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    const result = await this.disburse(phoneNumber, amount, "USD", requestId);
    return {
      success: result.success,
      data: result.data,
      error: result.error,
    };
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: ProviderTransactionStatus }> {
    const log = logger;
    log.info(maskPII({ referenceId }), "EcoCash: Querying transaction status");

    try {
      const response = await axios.get(this.joinUrl(this.statusPath), {
        params: { merchantCode: this.merchantCode, reference: referenceId },
        headers: { "Content-Type": "application/json" },
        timeout: this.timeoutMs,
      });

      const status = (
        response.data?.status as string | undefined
      )?.toUpperCase();
      if (status === "SUCCESS" || status === "COMPLETED") {
        return { status: "completed" };
      }
      if (status === "FAILED") {
        return { status: "failed" };
      }
      if (status === "PENDING") {
        return { status: "pending" };
      }
      return { status: "unknown" };
    } catch (error: unknown) {
      log.error(
        {
          referenceId,
          error: error instanceof Error ? error.message : String(error),
        },
        "EcoCash: Status query failed",
      );
      return { status: "unknown" };
    }
  }
}
