/**
 * MpesaProvider — Safaricom M-Pesa (Daraja API) provider for the Kenya corridor.
 *
 * Extends BaseProvider so the Basic-auth credential signature is inherited
 * from the shared core config class rather than duplicated inline, matching
 * the MtnMomoProvider pattern used for the MTN corridor.
 *
 * Authentication flow (OAuth2 client credentials):
 *   1. GET /oauth/v1/generate?grant_type=client_credentials with Basic auth
 *      header (consumer key:secret) → receive access_token
 *   2. Use Bearer token on all subsequent Daraja API calls
 *   3. Token is cached in-memory; re-fetched when stale
 *
 * Supported operations:
 *   - initiateStkPush   (C2B — Lipa Na M-Pesa Online / STK push)
 *   - sendB2CPayment    (B2C — Business to Customer disbursement)
 *   - processStkCallback (parses Safaricom's STK callback payload)
 *   - getTransactionStatus
 */

import { recordUssdPushDispatch } from "../../monitoring/metrics";
import axios from "axios";
import { BaseProvider, ProviderAuthConfig } from "./baseProvider";

// ─── Types ──────────────────────────────────────────────────────────────────

interface MpesaTokenResponse {
  access_token: string;
  expires_in: string | number;
}

export interface MpesaStkPushResult {
  success: boolean;
  merchantRequestId?: string;
  checkoutRequestId?: string;
  responseCode?: string;
  responseDescription?: string;
  error?: unknown;
}

export interface MpesaB2CResult {
  success: boolean;
  conversationId?: string;
  originatorConversationId?: string;
  responseCode?: string;
  responseDescription?: string;
  error?: unknown;
}

/** One item from Safaricom's CallbackMetadata.Item array. */
interface MpesaCallbackMetadataItem {
  Name: string;
  Value?: string | number;
}

/** Raw shape of the STK push callback body Safaricom POSTs to our webhook. */
export interface MpesaStkCallbackBody {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: {
        Item: MpesaCallbackMetadataItem[];
      };
    };
  };
}

/** Normalized response from Safaricom's `stkpushquery` (Lipa Na M-Pesa Query) endpoint. */
export interface MpesaStkQueryResult {
  success: boolean;
  resultCode?: number;
  resultDesc?: string;
  merchantRequestId?: string;
  checkoutRequestId?: string;
  responseCode?: string;
  responseDescription?: string;
  error?: unknown;
}

export interface MpesaCallbackResult {
  success: boolean;
  merchantRequestId: string;
  checkoutRequestId: string;
  resultCode: number;
  resultDesc: string;
  amount?: number;
  mpesaReceiptNumber?: string;
  transactionDate?: string;
  phoneNumber?: string;
}

/** Acknowledgement Safaricom expects in response to any callback POST. */
export const MPESA_CALLBACK_ACK = {
  ResultCode: 0,
  ResultDesc: "Success",
} as const;

/** One item from Safaricom's B2C Result `ResultParameters.ResultParameter` array. */
interface MpesaB2CResultParameter {
  Key: string;
  Value?: string | number;
}

/**
 * Raw shape of the B2C `ResultURL` callback body Safaricom POSTs once a
 * `sendB2CPayment` request reaches a terminal outcome.
 * See: Daraja B2C API — Result and Timeout notifications.
 */
export interface MpesaB2CResultBody {
  Result: {
    ResultType: number;
    ResultCode: number;
    ResultDesc: string;
    OriginatorConversationID: string;
    ConversationID: string;
    TransactionID?: string;
    ResultParameters?: {
      ResultParameter: MpesaB2CResultParameter[];
    };
  };
}

/** Raw shape of the B2C `QueueTimeOutURL` callback body. */
export interface MpesaB2CTimeoutBody {
  Result: {
    ResultType: number;
    ResultCode: number;
    ResultDesc: string;
    OriginatorConversationID: string;
    ConversationID: string;
  };
}

export type MpesaB2COutcomeStatus = "completed" | "failed";

/** Normalized outcome of a parsed B2C Result/QueueTimeOut callback. */
export interface MpesaB2COutcome {
  status: MpesaB2COutcomeStatus;
  resultCode: number;
  resultDesc: string;
  originatorConversationId: string;
  conversationId: string;
  transactionId?: string;
  transactionAmount?: number;
  transactionReceipt?: string;
  transactionCompletedDateTime?: string;
  receiverPartyPublicName?: string;
  b2cUtilityAccountAvailableFunds?: number;
  b2cWorkingAccountAvailableFunds?: number;
}

export type MpesaTransactionStatus =
  | "completed"
  | "failed"
  | "pending"
  | "unknown";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface MpesaConfig extends Partial<ProviderAuthConfig> {
  shortCode?: string;
  passkey?: string;
  callbackUrl?: string;
  initiatorName?: string;
  securityCredential?: string;
  resultUrl?: string;
  queueTimeoutUrl?: string;
}

function buildMpesaConfig(opts: MpesaConfig = {}): ProviderAuthConfig & {
  shortCode: string;
  passkey: string;
  callbackUrl: string;
  initiatorName: string;
  securityCredential: string;
  resultUrl: string;
  queueTimeoutUrl: string;
} {
  return {
    apiKey: opts.apiKey ?? process.env.MPESA_CONSUMER_KEY ?? "",
    apiSecret: opts.apiSecret ?? process.env.MPESA_CONSUMER_SECRET ?? "",
    baseUrl:
      opts.baseUrl ??
      process.env.MPESA_BASE_URL ??
      "https://sandbox.safaricom.co.ke",
    timeoutMs: opts.timeoutMs ?? 10_000,
    tokenExpiryLeewaySeconds: opts.tokenExpiryLeewaySeconds ?? 30,
    shortCode: opts.shortCode ?? process.env.MPESA_SHORTCODE ?? "",
    passkey: opts.passkey ?? process.env.MPESA_PASSKEY ?? "",
    callbackUrl: opts.callbackUrl ?? process.env.MPESA_CALLBACK_URL ?? "",
    initiatorName:
      opts.initiatorName ?? process.env.MPESA_INITIATOR_NAME ?? "",
    securityCredential:
      opts.securityCredential ??
      process.env.MPESA_SECURITY_CREDENTIAL ??
      "",
    resultUrl: opts.resultUrl ?? process.env.MPESA_RESULT_URL ?? "",
    queueTimeoutUrl:
      opts.queueTimeoutUrl ?? process.env.MPESA_QUEUE_TIMEOUT_URL ?? "",
  };
}

/** Builds the Daraja STK push `Password` — base64(shortcode + passkey + timestamp). */
function buildStkPassword(
  shortCode: string,
  passkey: string,
  timestamp: string,
): string {
  return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString("base64");
}

/** Daraja timestamp format: `YYYYMMDDHHmmss`. */
function buildTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** Normalizes a phone number to Safaricom's expected 2547XXXXXXXX format. */
function normalizeMsisdn(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.startsWith("7") || digits.startsWith("1")) return `254${digits}`;
  return digits;
}

// ─── Provider ───────────────────────────────────────────────────────────────

export class MpesaProvider extends BaseProvider {
  private readonly shortCode: string;
  private readonly passkey: string;
  private readonly callbackUrl: string;
  private readonly initiatorName: string;
  private readonly securityCredential: string;
  private readonly resultUrl: string;
  private readonly queueTimeoutUrl: string;

  constructor(opts: MpesaConfig = {}) {
    const config = buildMpesaConfig(opts);
    super(config);
    this.shortCode = config.shortCode;
    this.passkey = config.passkey;
    this.callbackUrl = config.callbackUrl;
    this.initiatorName = config.initiatorName;
    this.securityCredential = config.securityCredential;
    this.resultUrl = config.resultUrl;
    this.queueTimeoutUrl = config.queueTimeoutUrl;
  }

  // ─── Authentication ───────────────────────────────────────────────────────

  /**
   * Obtain a valid Daraja bearer token, using the in-memory cache when possible.
   * Uses `buildBasicAuthHeader()` inherited from BaseProvider so the
   * credential encoding lives in exactly one place.
   */
  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }

    const response = await axios.get<MpesaTokenResponse>(
      `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: this.buildBasicAuthHeader(this.apiKey, this.apiSecret),
        },
        timeout: this.timeoutMs,
      },
    );

    const { access_token, expires_in } = response.data;
    if (!access_token || typeof access_token !== "string") {
      throw new Error("M-Pesa token response did not include access_token");
    }

    this.cacheToken(access_token, Number(expires_in));
    return access_token;
  }

  // ─── API operations ────────────────────────────────────────────────────────

  /** Initiate an STK push (C2B — Lipa Na M-Pesa Online request-to-pay). */
  async initiateStkPush(
    phoneNumber: string,
    amount: number,
    accountReference: string,
    transactionDesc = "Stellar deposit",
  ): Promise<MpesaStkPushResult> {
    try {
      const token = await this.getAccessToken();
      const timestamp = buildTimestamp();
      const password = buildStkPassword(
        this.shortCode,
        this.passkey,
        timestamp,
      );
      const msisdn = normalizeMsisdn(phoneNumber);

      const response = await axios.post(
        `${this.baseUrl}/mpesa/stkpush/v1/processrequest`,
        {
          BusinessShortCode: this.shortCode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: Math.round(amount),
          PartyA: msisdn,
          PartyB: this.shortCode,
          PhoneNumber: msisdn,
          CallBackURL: this.callbackUrl,
          AccountReference: accountReference,
          TransactionDesc: transactionDesc,
        },
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(token),
          },
          timeout: this.timeoutMs,
        },
      );

      if (
        String(response.data.ResponseCode) === "0" &&
        typeof response.data.CheckoutRequestID === "string" &&
        response.data.CheckoutRequestID
      ) {
        recordUssdPushDispatch("mpesa", "KE", response.data.CheckoutRequestID);
      }

      return {
        success: true,
        merchantRequestId: response.data.MerchantRequestID,
        checkoutRequestId: response.data.CheckoutRequestID,
        responseCode: response.data.ResponseCode,
        responseDescription: response.data.ResponseDescription,
      };
    } catch (error) {
      return { success: false, error };
    }
  }

  /** Disburse funds to a phone number (B2C — Business to Customer). */
  async sendB2CPayment(
    phoneNumber: string,
    amount: number,
    remarks = "Payout",
  ): Promise<MpesaB2CResult> {
    try {
      const token = await this.getAccessToken();
      const msisdn = normalizeMsisdn(phoneNumber);

      const response = await axios.post(
        `${this.baseUrl}/mpesa/b2c/v1/paymentrequest`,
        {
          InitiatorName: this.initiatorName,
          SecurityCredential: this.securityCredential,
          CommandID: "BusinessPayment",
          Amount: Math.round(amount),
          PartyA: this.shortCode,
          PartyB: msisdn,
          Remarks: remarks,
          QueueTimeOutURL: this.queueTimeoutUrl,
          ResultURL: this.resultUrl,
          Occasion: "Payout",
        },
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(token),
          },
          timeout: this.timeoutMs,
        },
      );

      return {
        success: true,
        conversationId: response.data.ConversationID,
        originatorConversationId: response.data.OriginatorConversationID,
        responseCode: response.data.ResponseCode,
        responseDescription: response.data.ResponseDescription,
      };
    } catch (error) {
      return { success: false, error };
    }
  }

  /**
   * Query the Lipa Na M-Pesa Online (`stkpushquery`) endpoint for a checkout
   * request that has not yet received a callback.
   *
   * Safaricom returns the raw `ResultCode` / `ResultDesc` pair (for example
   * `1032` = cancelled by user, `1037` = handset/DS timeout). Unlike
   * {@link getTransactionStatus} this preserves the code so the caller can map
   * it to a precise transaction state — see `mpesaStkQuery.ts` (#1969).
   */
  async queryStkPush(checkoutRequestId: string): Promise<MpesaStkQueryResult> {
    try {
      const token = await this.getAccessToken();
      const timestamp = buildTimestamp();
      const password = buildStkPassword(
        this.shortCode,
        this.passkey,
        timestamp,
      );

      const response = await axios.post(
        `${this.baseUrl}/mpesa/stkpushquery/v1/query`,
        {
          BusinessShortCode: this.shortCode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId,
        },
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(token),
          },
          timeout: this.timeoutMs,
        },
      );

      const rawCode = response.data?.ResultCode;
      const resultCode = Number(rawCode);
      const resolvedCode = rawCode === undefined || rawCode === null || Number.isNaN(resultCode)
        ? undefined
        : resultCode;

      return {
        success: true,
        resultCode: resolvedCode,
        resultDesc: response.data?.ResultDesc,
        merchantRequestId: response.data?.MerchantRequestID,
        checkoutRequestId: response.data?.CheckoutRequestID,
        responseCode: response.data?.ResponseCode,
        responseDescription: response.data?.ResponseDescription,
      };
    } catch (error) {
      return { success: false, error };
    }
  }

  /** Query the status of a transaction by its checkout request ID. */
  async getTransactionStatus(
    checkoutRequestId: string,
  ): Promise<{ status: MpesaTransactionStatus }> {
    const query = await this.queryStkPush(checkoutRequestId);
    if (!query.success) return { status: "unknown" };
    if (query.resultCode === undefined) return { status: "pending" };
    return {
      status: query.resultCode === 0 ? "completed" : "failed",
    };
  }

  /**
   * Parses Safaricom's STK push callback body into a normalized result.
   * Safaricom expects `MPESA_CALLBACK_ACK` returned as the HTTP response
   * body regardless of the underlying transaction outcome.
   */
  static processStkCallback(body: MpesaStkCallbackBody): MpesaCallbackResult {
    const callback = body.Body.stkCallback;
    const items = callback.CallbackMetadata?.Item ?? [];

    const findItem = (name: string): string | number | undefined =>
      items.find((item) => item.Name === name)?.Value;

    return {
      success: callback.ResultCode === 0,
      merchantRequestId: callback.MerchantRequestID,
      checkoutRequestId: callback.CheckoutRequestID,
      resultCode: callback.ResultCode,
      resultDesc: callback.ResultDesc,
      amount:
        callback.ResultCode === 0
          ? Number(findItem("Amount")) || undefined
          : undefined,
      mpesaReceiptNumber:
        callback.ResultCode === 0
          ? (findItem("MpesaReceiptNumber") as string | undefined)
          : undefined,
      transactionDate:
        callback.ResultCode === 0
          ? String(findItem("TransactionDate") ?? "")
          : undefined,
      phoneNumber:
        callback.ResultCode === 0
          ? String(findItem("PhoneNumber") ?? "")
          : undefined,
    };
  }

  /**
   * Parses Safaricom's B2C `ResultURL` callback body into a normalized
   * outcome. `ResultCode === 0` is the only success case; every other code
   * (including timeouts routed here rather than to `QueueTimeOutURL`) is a
   * terminal failure — Safaricom does not report a "pending" B2C result.
   */
  static processB2CResult(body: MpesaB2CResultBody): MpesaB2COutcome {
    const result = body.Result;
    const items = result.ResultParameters?.ResultParameter ?? [];

    const findItem = (key: string): string | number | undefined =>
      items.find((item) => item.Key === key)?.Value;

    const isSuccess = result.ResultCode === 0;

    return {
      status: isSuccess ? "completed" : "failed",
      resultCode: result.ResultCode,
      resultDesc: result.ResultDesc,
      originatorConversationId: result.OriginatorConversationID,
      conversationId: result.ConversationID,
      transactionId: result.TransactionID,
      transactionAmount: isSuccess
        ? Number(findItem("TransactionAmount")) || undefined
        : undefined,
      transactionReceipt: isSuccess
        ? (findItem("TransactionReceipt") as string | undefined)
        : undefined,
      transactionCompletedDateTime: isSuccess
        ? String(findItem("TransactionCompletedDateTime") ?? "") || undefined
        : undefined,
      receiverPartyPublicName: isSuccess
        ? (findItem("ReceiverPartyPublicName") as string | undefined)
        : undefined,
      b2cUtilityAccountAvailableFunds:
        Number(findItem("B2CUtilityAccountAvailableFunds")) || undefined,
      b2cWorkingAccountAvailableFunds:
        Number(findItem("B2CWorkingAccountAvailableFunds")) || undefined,
    };
  }

  /**
   * Parses Safaricom's B2C `QueueTimeOutURL` callback body. A queue timeout
   * always represents a failed disbursement attempt (the request never
   * reached a terminal processing state within Safaricom's queue), so this
   * normalizes to the same {@link MpesaB2COutcome} shape as a failed result.
   */
  static processB2CTimeout(body: MpesaB2CTimeoutBody): MpesaB2COutcome {
    const result = body.Result;
    return {
      status: "failed",
      resultCode: result.ResultCode,
      resultDesc: result.ResultDesc || "B2C request timed out in queue",
      originatorConversationId: result.OriginatorConversationID,
      conversationId: result.ConversationID,
    };
  }
}
