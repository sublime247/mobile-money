import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { createHmac, randomUUID } from "crypto";
import logger from "../../../utils/logger";
import { maskPII } from "../../../utils/masking";

const DEFAULT_BASE_URL = "https://api.orange.com";
const DEFAULT_AUTH_PATH = "/oauth/token";
const DEFAULT_PAYMENT_PATH = "/orange-money-webpay/mg/v1/payments/collect";
const DEFAULT_PAYOUT_PATH = "/orange-money-webpay/mg/v1/payments/disburse";
const DEFAULT_STATUS_PATH = "/orange-money-webpay/mg/v1/payments";
const DEFAULT_CURRENCY = "MGA";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SESSION_TTL_MS = 3600 * 1000;
const DEFAULT_REFRESH_SKEW_MS = 60 * 1000;

export interface BatchPayoutItem {
  referenceId: string;
  phoneNumber: string;
  amount: string;
}

export interface BatchPayoutResult {
  referenceId: string;
  success: boolean;
  error?: string;
  providerReference?: string;
}

type OrangeMadagascarResult = {
  success: boolean;
  data?: unknown;
  error?: unknown;
  reference?: string;
};

export class OrangeMadagascarProvider {
  private readonly baseUrl: string;
  private readonly authPath: string;
  private readonly paymentPath: string;
  private readonly payoutPath: string;
  private readonly statusPath: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly currency: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly refreshSkewMs: number;
  private readonly sessionTtlMs: number;
  private readonly callbackSecret: string;
  private readonly callbackSignatureHeader: string;

  private readonly httpClient: AxiosInstance;
  private readonly clock: () => number;

  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private authPromise: Promise<string> | null = null;
  private prefetchTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor() {
    this.clock = Date.now;
    this.baseUrl = process.env.ORANGE_MADAGASCAR_BASE_URL ?? DEFAULT_BASE_URL;
    this.authPath = process.env.ORANGE_MADAGASCAR_AUTH_PATH ?? DEFAULT_AUTH_PATH;
    this.paymentPath = process.env.ORANGE_MADAGASCAR_PAYMENT_PATH ?? DEFAULT_PAYMENT_PATH;
    this.payoutPath = process.env.ORANGE_MADAGASCAR_PAYOUT_PATH ?? DEFAULT_PAYOUT_PATH;
    this.statusPath = process.env.ORANGE_MADAGASCAR_STATUS_PATH ?? DEFAULT_STATUS_PATH;
    this.apiKey = process.env.ORANGE_MADAGASCAR_API_KEY ?? "";
    this.apiSecret = process.env.ORANGE_MADAGASCAR_API_SECRET ?? "";
    this.currency = process.env.ORANGE_MADAGASCAR_CURRENCY ?? DEFAULT_CURRENCY;
    this.timeoutMs = Number(process.env.ORANGE_MADAGASCAR_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    this.maxAttempts = Number(process.env.ORANGE_MADAGASCAR_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);
    this.refreshSkewMs = Number(process.env.ORANGE_MADAGASCAR_REFRESH_SKEW_MS ?? DEFAULT_REFRESH_SKEW_MS);
    this.sessionTtlMs = Number(process.env.ORANGE_MADAGASCAR_SESSION_TTL_MS ?? DEFAULT_SESSION_TTL_MS);
    this.callbackSecret = process.env.ORANGE_MADAGASCAR_CALLBACK_SECRET ?? "";
    this.callbackSignatureHeader =
      process.env.ORANGE_MADAGASCAR_CALLBACK_SIGNATURE_HEADER?.toLowerCase() ?? "x-callback-signature";

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      validateStatus: () => true,
    });
  }

  async requestPayment(
    phoneNumber: string,
    amount: string | number,
    requestId?: string,
  ): Promise<OrangeMadagascarResult> {
    return this.executeOperation("payment", phoneNumber, String(amount), requestId);
  }

  async sendPayout(
    phoneNumber: string,
    amount: string | number,
    requestId?: string,
  ): Promise<OrangeMadagascarResult> {
    return this.executeOperation("payout", phoneNumber, String(amount), requestId);
  }

  async sendBatchPayout(items: BatchPayoutItem[]): Promise<{
    success: boolean;
    results: BatchPayoutResult[];
    error?: unknown;
  }> {
    const MAX_BATCH_SIZE = 50;
    if (items.length === 0) {
      return { success: true, results: [] };
    }
    if (items.length > MAX_BATCH_SIZE) {
      return {
        success: false,
        results: items.map((item) => ({
          referenceId: item.referenceId,
          success: false,
          error: `Batch size exceeds maximum of ${MAX_BATCH_SIZE}`,
        })),
        error: new Error(`Batch size ${items.length} exceeds maximum of ${MAX_BATCH_SIZE}`),
      };
    }

    logger.info({ itemCount: items.length }, "OrangeMadagascar: Starting batch payout");
    const startTime = Date.now();

    try {
      const token = await this.getAccessToken();
      const batchId = `BATCH-${randomUUID()}`;

      const response = await this.sendRequest({
        method: "POST",
        url: `${this.baseUrl}${this.payoutPath}/batch`,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        data: {
          batchId,
          currency: this.currency,
          items: items.map((item) => ({
            referenceId: item.referenceId,
            amount: parseFloat(item.amount),
            msisdn: item.phoneNumber,
          })),
        },
      });

      const responseItems = response.data?.items ?? [];
      const results: BatchPayoutResult[] = items.map((item) => {
        const respItem = responseItems.find(
          (r: { referenceId: string }) => r.referenceId === item.referenceId,
        );
        if (!respItem) {
          return { referenceId: item.referenceId, success: false, error: "No response for item" };
        }
        const ok = String(respItem.status ?? "").toUpperCase() === "SUCCESSFUL";
        return {
          referenceId: item.referenceId,
          success: ok,
          error: ok ? undefined : respItem.errorReason ?? `Status: ${respItem.status}`,
          providerReference: respItem.transactionId,
        };
      });

      const successCount = results.filter((r) => r.success).length;
      logger.info(
        { duration: Date.now() - startTime, successCount, failureCount: results.length - successCount, batchId },
        "OrangeMadagascar: Batch payout completed",
      );

      return {
        success: successCount > 0,
        results,
        error: successCount === 0 ? new Error("All batch items failed") : undefined,
      };
    } catch (error: any) {
      logger.error({ error: error.message, itemCount: items.length }, "OrangeMadagascar: Batch payout failed");
      return {
        success: false,
        results: items.map((item) => ({
          referenceId: item.referenceId,
          success: false,
          error: error.message,
        })),
        error,
      };
    }
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
    try {
      const token = await this.getAccessToken();
      const response = await this.sendRequest({
        method: "GET",
        url: `${this.baseUrl}${this.statusPath}/${encodeURIComponent(referenceId)}`,
        headers: { Authorization: `Bearer ${token}` },
      });

      const providerStatus = String(response.data?.status ?? "").toUpperCase();
      if (providerStatus === "SUCCESSFUL") return { status: "completed" };
      if (providerStatus === "FAILED") return { status: "failed" };
      if (providerStatus === "PENDING" || providerStatus === "IN_PROGRESS") return { status: "pending" };
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  async getOperationalBalance(): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    try {
      const token = await this.getAccessToken();
      const response = await this.sendRequest({
        method: "GET",
        url: `${this.baseUrl}/orange-money-webpay/mg/v1/account/balance`,
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true, data: response.data };
      }
      return { success: false, error: { status: response.status, data: response.data } };
    } catch (error) {
      return { success: false, error };
    }
  }

  /** Verify an incoming callback payload signature. */
  verifyCallbackSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!this.callbackSecret || !signatureHeader) {
      return false;
    }

    const incoming = signatureHeader.startsWith("sha256=")
      ? signatureHeader.slice(7)
      : signatureHeader;

    const expected = createHmac("sha256", this.callbackSecret)
      .update(rawBody)
      .digest("hex");

    if (incoming.length !== expected.length) {
      return false;
    }

    try {
      const key = Buffer.from(expected);
      const message = Buffer.from(incoming);
      if (key.length !== message.length) return false;
      const crypto = require("crypto");
      return crypto.timingSafeEqual(key, message);
    } catch {
      return false;
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }
  }

  private async executeOperation(
    operation: "payment" | "payout",
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<OrangeMadagascarResult> {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(maskPII({ phoneNumber, amount, operation }), "OrangeMadagascar: Executing operation");
    const startTime = Date.now();

    try {
      const reference = this.createReference(operation);
      const endpoint = operation === "payment" ? this.paymentPath : this.payoutPath;

      const response = await this.executeWithRetry({
        method: "POST",
        url: `${this.baseUrl}${endpoint}`,
        data:
          operation === "payment"
            ? {
                reference,
                subscriber: { msisdn: phoneNumber },
                transaction: {
                  amount: parseFloat(amount),
                  currency: this.currency,
                },
              }
            : {
                reference,
                payee: { msisdn: phoneNumber },
                transaction: {
                  amount: parseFloat(amount),
                  currency: this.currency,
                },
              },
      });

      const duration = Date.now() - startTime;
      log.info(maskPII({ duration, status: response.status }), "OrangeMadagascar: Operation completed");

      return this.toProviderResult(response, reference);
    } catch (error: any) {
      const duration = Date.now() - startTime;
      log.error({ duration, error: error.message }, "OrangeMadagascar: Operation failed");
      return { success: false, error, reference: this.createReference(operation) };
    }
  }

  private async executeWithRetry(
    request: AxiosRequestConfig,
  ): Promise<AxiosResponse> {
    let lastResponse: AxiosResponse | null = null;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const token = await this.getAccessToken();
        const requestHeaders = (request.headers ?? {}) as Record<string, string>;
        const response = await this.sendRequest({
          ...request,
          headers: {
            ...requestHeaders,
            Authorization: `Bearer ${token}`,
            "Content-Type": requestHeaders["Content-Type"] ?? "application/json",
          },
        });

        if (response.status === 401 || response.status === 403) {
          this.accessToken = null;
          lastResponse = response;
          continue;
        }

        if (response.status >= 500 && attempt < this.maxAttempts) {
          lastResponse = response;
          await this.delay(attempt);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxAttempts) throw error;
        await this.delay(attempt);
      }
    }

    if (lastResponse) return lastResponse;
    throw lastError ?? new Error("OrangeMadagascar request failed");
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    const now = this.clock();
    if (!forceRefresh && this.accessToken && now < this.tokenExpiry - this.refreshSkewMs) {
      return this.accessToken;
    }

    if (this.authPromise) {
      return this.authPromise;
    }

    this.authPromise = (async () => {
      try {
        const authHeader =
          "Basic " +
          Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64");

        const response = await this.sendRequest({
          method: "POST",
          url: `${this.baseUrl}${this.authPath}`,
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          data: "grant_type=client_credentials",
        });

        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            `OrangeMadagascar auth failed with status ${response.status}`,
          );
        }

        const data = response.data as {
          access_token?: string;
          expires_in?: number;
        };
        if (!data.access_token) {
          throw new Error("OrangeMadagascar auth did not return access_token");
        }

        this.accessToken = data.access_token;
        const expiresIn = data.expires_in ?? 3600;
        this.tokenExpiry = now + expiresIn * 1000;

        this.schedulePrefetch(expiresIn * 1000);

        return this.accessToken;
      } finally {
        this.authPromise = null;
      }
    })();

    return this.authPromise;
  }

  private schedulePrefetch(ttlMs: number, isRetry = false): void {
    if (this.destroyed) return;

    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }

    const delay = isRetry
      ? ttlMs
      : Math.max(1000, ttlMs - this.refreshSkewMs);

    this.prefetchTimer = setTimeout(async () => {
      if (this.destroyed) return;
      try {
        logger.info("OrangeMadagascar: Pre-fetching access token");
        await this.getAccessToken(true);
      } catch (error: any) {
        if (this.destroyed) return;
        logger.error({ error: error.message }, "OrangeMadagascar: Token pre-fetch failed, retrying");
        this.schedulePrefetch(5000, true);
      }
    }, delay);

    if (this.prefetchTimer && typeof this.prefetchTimer.unref === "function") {
      this.prefetchTimer.unref();
    }
  }

  private async sendRequest(
    config: AxiosRequestConfig,
  ): Promise<AxiosResponse> {
    return this.httpClient.request(config);
  }

  private toProviderResult(
    response: AxiosResponse,
    reference?: string,
  ): OrangeMadagascarResult {
    const status = response.status ?? 200;
    if (status >= 200 && status < 300) {
      return { success: true, data: response.data, reference };
    }
    return {
      success: false,
      reference,
      error: { status, data: response.data },
    };
  }

  private createReference(operation: "payment" | "payout"): string {
    return `ORANGE-MG-${operation.toUpperCase()}-${this.clock()}-${randomUUID().slice(0, 8)}`;
  }

  private async delay(attempt: number): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250 * attempt, 1000)),
    );
  }
}
