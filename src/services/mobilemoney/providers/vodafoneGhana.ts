//! Vodafone Cash Ghana (Telecel) provider client (#1961).
//!
//! Follows the same minimal, direct-axios shape as WaveSenegalProvider
//! (`./waveSenegal.ts`): a `requestPayment`/`sendPayout`/
//! `getTransactionStatus` trio matching `MobileMoneyProvider`
//! (`../mobileMoneyService.ts`), plus a webhook signature verifier and a
//! static callback parser, mirroring WaveSenegalProvider's own
//! `verifyWebhookSignature` and Vodacom's callback-parsing precedent.
//!
//! Vodafone Cash Ghana collections can additionally be authorized by a
//! merchant-generated voucher code instead of (or alongside) a USSD PIN
//! prompt, which this adapter's `requestPayment` accepts as an optional
//! third parameter.

import axios, { AxiosInstance } from "axios";
import { createHmac, timingSafeEqual } from "crypto";

export type VodafoneGhanaTransactionStatus =
  "completed" | "failed" | "pending" | "unknown";

interface VodafoneCollectionResponse {
  transactionId?: string;
  status?: string;
  voucherCode?: string;
  message?: string;
}

interface VodafoneStatusResponse {
  transactionId?: string;
  status?: string;
  amount?: string | number;
  currency?: string;
}

interface VodafonePayoutResponse {
  transactionId?: string;
  status?: string;
  message?: string;
}

/**
 * The webhook payload Vodafone Cash Ghana posts back once a collection or
 * payout settles. Field names are provisional (no live sandbox account was
 * available to confirm the exact contract); `parseCallback` is defensive
 * about missing fields for that reason.
 */
export interface VodafoneGhanaCallbackPayload {
  transactionId?: string;
  referenceId?: string;
  status?: string;
  amount?: string | number;
  currency?: string;
  msisdn?: string;
  voucherCode?: string;
  failureReason?: string;
}

export interface VodafoneGhanaCallbackResult {
  transactionId: string;
  status: VodafoneGhanaTransactionStatus;
  amount?: string;
  currency?: string;
  msisdn?: string;
  voucherCode?: string;
  failureReason?: string;
}

export class VodafoneGhanaProvider {
  private readonly client: AxiosInstance;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly merchantCode: string;
  private readonly callbackSecret: string;
  private readonly currency: string;

  constructor() {
    this.apiKey = process.env.VODAFONE_GH_API_KEY || "";
    this.apiSecret = process.env.VODAFONE_GH_API_SECRET || "";
    this.merchantCode = process.env.VODAFONE_GH_MERCHANT_CODE || "";
    this.callbackSecret = process.env.VODAFONE_GH_CALLBACK_SECRET || "";
    this.currency = process.env.VODAFONE_GH_CURRENCY || "GHS";

    this.client = axios.create({
      baseURL:
        process.env.VODAFONE_GH_BASE_URL || "https://sandbox.vodafone.com.gh",
      timeout: Number(process.env.VODAFONE_GH_TIMEOUT_MS || 30000),
      headers: {
        Authorization: this.buildBasicAuthHeader(),
        "Content-Type": "application/json",
      },
    });
  }

  private buildBasicAuthHeader(): string {
    const token = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString(
      "base64",
    );
    return `Basic ${token}`;
  }

  /**
   * Request a payment (collection) from a customer phone number.
   *
   * `voucherCode` authorizes the debit via a merchant-generated voucher
   * instead of a USSD PIN prompt (#1961's acceptance criterion). When
   * omitted, the customer is expected to approve a USSD push prompt on
   * their handset instead, matching every other provider's default flow.
   */
  async requestPayment(
    phoneNumber: string,
    amount: string,
    voucherCode?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    try {
      const clientReference = `VODAFONE-GH-PAY-${Date.now()}`;
      const response = await this.client.post<VodafoneCollectionResponse>(
        "/v1/collections",
        {
          merchantCode: this.merchantCode,
          amount: String(amount),
          currency: this.currency,
          msisdn: this.normalizePhone(phoneNumber),
          clientReference,
          ...(voucherCode ? { voucherCode } : {}),
        },
      );

      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error };
    }
  }

  /**
   * Send a payout (disbursement) to a mobile wallet.
   */
  async sendPayout(
    phoneNumber: string,
    amount: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    try {
      const clientReference = `VODAFONE-GH-OUT-${Date.now()}`;
      const response = await this.client.post<VodafonePayoutResponse>(
        "/v1/disbursements",
        {
          merchantCode: this.merchantCode,
          amount: String(amount),
          currency: this.currency,
          msisdn: this.normalizePhone(phoneNumber),
          clientReference,
        },
      );

      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error };
    }
  }

  /**
   * Retrieve the canonical settlement status of a transaction by Vodafone
   * transaction ID (#1961's "track transaction settlement status").
   */
  async getTransactionStatus(
    transactionId: string,
  ): Promise<{ status: VodafoneGhanaTransactionStatus }> {
    try {
      const response = await this.client.get<VodafoneStatusResponse>(
        `/v1/transactions/${encodeURIComponent(transactionId)}`,
      );

      return { status: this.mapStatus(response.data?.status) };
    } catch {
      return { status: "unknown" };
    }
  }

  /**
   * Verify a Vodafone Cash Ghana webhook signature. Same HMAC-SHA256
   * `sha256=<hex>` scheme as WaveSenegalProvider.verifyWebhookSignature
   * and the MTN/Orange Guinea callback middleware.
   */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
    if (!this.callbackSecret) return false;

    const expected =
      "sha256=" +
      createHmac("sha256", this.callbackSecret).update(rawBody).digest("hex");

    if (expected.length !== signature.length) return false;

    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  /**
   * Parse a Vodafone Cash Ghana webhook body into the normalized shape the
   * rest of the platform consumes (#1961's "parse webhook feedback"). A
   * static method since parsing needs no instance state, matching
   * MpesaProvider.processStkCallback's precedent.
   */
  static parseCallback(
    payload: VodafoneGhanaCallbackPayload,
  ): VodafoneGhanaCallbackResult {
    const transactionId = payload.transactionId || payload.referenceId || "";

    return {
      transactionId,
      status: VodafoneGhanaProvider.mapCallbackStatus(payload.status),
      amount: payload.amount !== undefined ? String(payload.amount) : undefined,
      currency: payload.currency,
      msisdn: payload.msisdn,
      voucherCode: payload.voucherCode,
      failureReason: payload.failureReason,
    };
  }

  private static mapCallbackStatus(
    status?: string,
  ): VodafoneGhanaTransactionStatus {
    switch ((status ?? "").toLowerCase()) {
      case "success":
      case "successful":
      case "completed":
        return "completed";
      case "failed":
      case "error":
      case "declined":
        return "failed";
      case "pending":
      case "processing":
        return "pending";
      default:
        return "unknown";
    }
  }

  private mapStatus(vodafoneStatus?: string): VodafoneGhanaTransactionStatus {
    return VodafoneGhanaProvider.mapCallbackStatus(vodafoneStatus);
  }

  /**
   * Normalize a phone number to the format Vodafone Cash Ghana expects
   * (no leading +). Ghana country code: 233.
   */
  private normalizePhone(phoneNumber: string): string {
    const digits = phoneNumber.replace(/\D/g, "");
    if (digits.startsWith("233")) return digits;
    if (digits.startsWith("0")) return `233${digits.slice(1)}`;
    return `233${digits}`;
  }
}
