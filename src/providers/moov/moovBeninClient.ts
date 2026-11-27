import { AxiosError } from "axios";
import { createHmac, randomUUID } from "crypto";
import { providerHttp } from "../../services/providerStatus";
import logger from "../../utils/logger";
import { maskPII } from "../../utils/masking";

const http = providerHttp("moov-bj");

/**
 * Moov Africa Benin push USSD ("STK push") collection client (#2559).
 *
 * Flow:
 *   1. `initiatePush` sends a signed push request; Moov rings the customer's
 *      handset with a PIN prompt and answers synchronously with an
 *      acknowledgement (accepted / rejected). The bridge assigns its own
 *      tracking reference before the call so the transaction is traceable
 *      even when the gateway never answers.
 *   2. The final outcome (customer authorised, declined, or let the prompt
 *      time out) arrives later. When no callback arrives, `checkStatus`
 *      polls Moov for the push by tracking reference.
 *
 * Every request carries an HMAC-SHA256 merchant signature over a canonical
 * string (see {@link buildSignaturePayload}) plus the timestamp it covers, so
 * Moov can reject tampered or replayed requests.
 */

export const MOOV_BENIN_COUNTRY_CODE = "229";
export const MOOV_BENIN_CURRENCY = "XOF";

/** Normalised lifecycle of a push collection. */
export type MoovBeninPushStatus =
  /** Prompt delivered, customer has not acted yet. */
  | "PENDING"
  /** Customer entered their PIN — funds collected. */
  | "SUCCESSFUL"
  /** Customer declined the prompt (or entered a wrong PIN too often). */
  | "REJECTED"
  /** Prompt expired without customer action. */
  | "EXPIRED"
  /** Gateway-side failure (insufficient funds, account barred, …). */
  | "FAILED"
  /** Outcome unknown (gateway timeout) — must be resolved via checkStatus. */
  | "UNKNOWN";

export interface MoovBeninPushRequest {
  /** Customer MSISDN, local (e.g. 97000000) or with 229 prefix. */
  phoneNumber: string;
  /** Amount in whole XOF (no minor unit). */
  amount: number;
  /** Optional caller-supplied tracking reference; generated when omitted. */
  reference?: string;
  description?: string;
}

export interface MoovBeninPushResult {
  /** `true` when Moov acknowledged the push (prompt sent to the handset). */
  accepted: boolean;
  status: MoovBeninPushStatus;
  /** Bridge-side tracking reference — use it for {@link MoovBeninClient.checkStatus}. */
  trackingReference: string;
  providerTransactionId?: string;
  providerCode?: string;
  message?: string;
  /** `true` when the request may be retried / the status should be polled. */
  retryable: boolean;
  /** `true` when the gateway did not answer in time — outcome is unknown. */
  timedOut?: boolean;
}

export interface MoovBeninStatusResult {
  trackingReference: string;
  status: MoovBeninPushStatus;
  /** `true` once the status will no longer change. */
  final: boolean;
  providerTransactionId?: string;
  providerCode?: string;
  message?: string;
  timedOut?: boolean;
}

export interface MoovBeninClientConfig {
  baseUrl?: string;
  merchantId?: string;
  apiKey?: string;
  /** HMAC secret used to sign requests. */
  signingSecret?: string;
  pushPath?: string;
  /** Status path; `{reference}` is replaced by the tracking reference. */
  statusPath?: string;
  timeoutMs?: number;
  /** Injectable clock (ms since epoch) for deterministic signatures in tests. */
  now?: () => number;
}

const FINAL_STATUSES: ReadonlySet<MoovBeninPushStatus> = new Set([
  "SUCCESSFUL",
  "REJECTED",
  "EXPIRED",
  "FAILED",
]);

/**
 * Maps Moov's raw status/code vocabulary onto {@link MoovBeninPushStatus}.
 * Moov reports both textual statuses and numeric result codes depending on
 * the endpoint, so both are accepted.
 */
export function mapMoovBeninStatus(raw: unknown): MoovBeninPushStatus {
  const value = String(raw ?? "").trim().toUpperCase();
  switch (value) {
    case "SUCCESS":
    case "SUCCESSFUL":
    case "COMPLETED":
    case "APPROVED":
    case "0":
      return "SUCCESSFUL";
    case "PENDING":
    case "ACCEPTED":
    case "INITIATED":
    case "PROCESSING":
    case "IN_PROGRESS":
    case "100":
      return "PENDING";
    case "REJECTED":
    case "DECLINED":
    case "CANCELLED":
    case "CANCELED":
    case "USER_REJECTED":
    case "INVALID_PIN":
    case "17":
      return "REJECTED";
    case "EXPIRED":
    case "TIMEOUT":
    case "USER_TIMEOUT":
    case "18":
      return "EXPIRED";
    case "":
      return "UNKNOWN";
    default:
      return "FAILED";
  }
}

export function normalizeBeninMsisdn(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "").replace(/^00/, "");
  return digits.startsWith(MOOV_BENIN_COUNTRY_CODE)
    ? digits
    : `${MOOV_BENIN_COUNTRY_CODE}${digits}`;
}

/** Benin numbers: 229 + 8 digits (legacy) or 229 + 10 digits (01-prefixed, 2024 plan). */
export function isValidBeninMsisdn(phoneNumber: string): boolean {
  return /^229(\d{8}|01\d{8})$/.test(normalizeBeninMsisdn(phoneNumber));
}

/** Canonical string covered by the merchant signature. */
export function buildSignaturePayload(fields: {
  merchantId: string;
  reference: string;
  msisdn?: string;
  amount?: number;
  currency?: string;
  timestamp: string;
}): string {
  return [
    fields.merchantId,
    fields.reference,
    fields.msisdn ?? "",
    fields.amount != null ? String(fields.amount) : "",
    fields.currency ?? "",
    fields.timestamp,
  ].join("|");
}

export function signMoovBeninPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof AxiosError)) return false;
  return (
    error.code === "ECONNABORTED" ||
    error.code === "ETIMEDOUT" ||
    error.response?.status === 504 ||
    error.response?.status === 408
  );
}

export class MoovBeninClient {
  private readonly baseUrl: string;
  private readonly merchantId: string;
  private readonly apiKey: string;
  private readonly signingSecret: string;
  private readonly pushPath: string;
  private readonly statusPath: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(config: MoovBeninClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? process.env.MOOV_BENIN_BASE_URL ?? "";
    this.merchantId = config.merchantId ?? process.env.MOOV_BENIN_MERCHANT_ID ?? "";
    this.apiKey = config.apiKey ?? process.env.MOOV_BENIN_API_KEY ?? "";
    this.signingSecret =
      config.signingSecret ?? process.env.MOOV_BENIN_SIGNING_SECRET ?? "";
    this.pushPath =
      config.pushPath ?? process.env.MOOV_BENIN_PUSH_PATH ?? "/api/v1/collections/push";
    this.statusPath =
      config.statusPath ??
      process.env.MOOV_BENIN_STATUS_PATH ??
      "/api/v1/collections/{reference}/status";
    this.timeoutMs =
      config.timeoutMs ?? (Number(process.env.MOOV_BENIN_TIMEOUT_MS) || 15_000);
    this.now = config.now ?? Date.now;
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  private signedHeaders(payload: Parameters<typeof buildSignaturePayload>[0]) {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "X-Merchant-Id": this.merchantId,
      "X-Timestamp": payload.timestamp,
      "X-Signature": signMoovBeninPayload(
        buildSignaturePayload(payload),
        this.signingSecret,
      ),
    };
  }

  /**
   * Sends a push USSD prompt to the customer's handset and parses Moov's
   * immediate acknowledgement.
   */
  async initiatePush(request: MoovBeninPushRequest): Promise<MoovBeninPushResult> {
    const trackingReference = request.reference ?? `MOOVBJ-${randomUUID()}`;
    const log = logger.child({ provider: "moov-bj", trackingReference });

    if (!isValidBeninMsisdn(request.phoneNumber)) {
      return {
        accepted: false,
        status: "FAILED",
        trackingReference,
        message: "Moov Benin push only supports Beninese (+229) numbers",
        retryable: false,
      };
    }
    if (!Number.isInteger(request.amount) || request.amount <= 0) {
      return {
        accepted: false,
        status: "FAILED",
        trackingReference,
        message: "Amount must be a positive whole number of XOF",
        retryable: false,
      };
    }

    const msisdn = normalizeBeninMsisdn(request.phoneNumber);
    const timestamp = new Date(this.now()).toISOString();
    const body = {
      merchantId: this.merchantId,
      reference: trackingReference,
      msisdn,
      amount: request.amount,
      currency: MOOV_BENIN_CURRENCY,
      description: request.description ?? "Deposit",
      timestamp,
    };

    try {
      const response = await http.post(this.url(this.pushPath), body, {
        headers: this.signedHeaders({
          merchantId: this.merchantId,
          reference: trackingReference,
          msisdn,
          amount: request.amount,
          currency: MOOV_BENIN_CURRENCY,
          timestamp,
        }),
        timeout: this.timeoutMs,
      });

      const data = (response.data ?? {}) as Record<string, unknown>;
      const status = mapMoovBeninStatus(data.status ?? data.responseCode ?? "PENDING");
      const accepted = status === "PENDING" || status === "SUCCESSFUL";

      log.info(
        maskPII({ msisdn, amount: request.amount, status }),
        "Moov Benin push: acknowledgement received",
      );

      return {
        accepted,
        status,
        trackingReference,
        providerTransactionId: (data.transactionId ?? data.transId) as string | undefined,
        providerCode: data.responseCode != null ? String(data.responseCode) : undefined,
        message: data.message as string | undefined,
        retryable: false,
      };
    } catch (error: unknown) {
      if (isTimeout(error)) {
        // The prompt may or may not have reached the handset — never resend
        // blindly (double prompt / double debit); resolve via checkStatus.
        log.warn("Moov Benin push: gateway timeout — outcome unknown");
        return {
          accepted: false,
          status: "UNKNOWN",
          trackingReference,
          message: "Moov Benin gateway timed out; check the transaction status",
          retryable: true,
          timedOut: true,
        };
      }

      const axiosError = error instanceof AxiosError ? error : undefined;
      const data = (axiosError?.response?.data ?? {}) as Record<string, unknown>;
      const httpStatus = axiosError?.response?.status;
      const providerCode =
        data.responseCode != null ? String(data.responseCode) : (data.code as string | undefined);

      log.error(
        maskPII({ msisdn, httpStatus, providerCode }),
        "Moov Benin push: request rejected",
      );

      return {
        accepted: false,
        status: data.status ? mapMoovBeninStatus(data.status) : "FAILED",
        trackingReference,
        providerCode,
        message: (data.message as string | undefined) ?? "Moov Benin push request failed",
        retryable: httpStatus == null || httpStatus >= 500 || httpStatus === 429,
      };
    }
  }

  /**
   * Fallback status lookup for pushes whose callback never arrived.
   */
  async checkStatus(trackingReference: string): Promise<MoovBeninStatusResult> {
    if (!trackingReference) throw new Error("trackingReference is required");

    const timestamp = new Date(this.now()).toISOString();
    const path = this.statusPath.replace(
      "{reference}",
      encodeURIComponent(trackingReference),
    );

    try {
      const response = await http.get(this.url(path), {
        headers: this.signedHeaders({
          merchantId: this.merchantId,
          reference: trackingReference,
          timestamp,
        }),
        timeout: this.timeoutMs,
      });
      const data = (response.data ?? {}) as Record<string, unknown>;
      const status = mapMoovBeninStatus(data.status ?? data.responseCode);

      return {
        trackingReference,
        status,
        final: FINAL_STATUSES.has(status),
        providerTransactionId: (data.transactionId ?? data.transId) as string | undefined,
        providerCode: data.responseCode != null ? String(data.responseCode) : undefined,
        message: data.message as string | undefined,
      };
    } catch (error: unknown) {
      if (isTimeout(error)) {
        return {
          trackingReference,
          status: "UNKNOWN",
          final: false,
          timedOut: true,
          message: "Moov Benin gateway timed out",
        };
      }
      const axiosError = error instanceof AxiosError ? error : undefined;
      if (axiosError?.response?.status === 404) {
        return {
          trackingReference,
          status: "FAILED",
          final: true,
          message: "Transaction not found at Moov Benin",
        };
      }
      logger.error(
        { trackingReference, httpStatus: axiosError?.response?.status },
        "Moov Benin status check failed",
      );
      return {
        trackingReference,
        status: "UNKNOWN",
        final: false,
        message: "Moov Benin status check failed",
      };
    }
  }
}

let defaultClient: MoovBeninClient | null = null;

export function getMoovBeninClient(): MoovBeninClient {
  if (!defaultClient) defaultClient = new MoovBeninClient();
  return defaultClient;
}
