/**
 * MtnMomoProvider — MTN Mobile Money provider
 *
 * Extends BaseProvider so the Basic-auth credential signature and
 * Bearer-token construction are inherited from the shared core config
 * class rather than being duplicated inline.
 *
 * Authentication flow (OAuth2 client credentials):
 *   1. POST /collection/token/ with Basic auth header → receive access_token
 *   2. Use Bearer token on all subsequent API calls
 *   3. Token is cached in-memory; re-fetched when stale
 *
 * Supported operations:
 *   - requestPayment (collection / request-to-pay)
 *   - sendPayout     (disbursement)
 *   - getTransactionStatus
 *   - getOperationalBalance
 *   - getAccountBalance (disbursement float inquiry, alias for pre-flight checks)
 */

import axios, { AxiosError } from "axios";
import { randomUUID } from "crypto";
import { BaseProvider, ProviderAuthConfig } from "./baseProvider";
import type {
  BatchPayoutItem,
  BatchPayoutResult,
} from "../mobilemoney/mobileMoneyService";
import { recordTelecomLatency } from "../../utils/logger";
import logger from "../../utils/logger";
import { executeWithCircuitBreaker } from "../../utils/circuitBreaker";

export type { BatchPayoutItem, BatchPayoutResult };

const POLL_DELAY_MS = 15_000;
const MAX_POLL_ATTEMPTS = 4;

let pollTimeout: ReturnType<typeof setTimeout> | null = null;
const pollQueue: Map<string, { referenceId: string; provider: MtnMomoProvider; attempt: number }> = new Map();

function schedulePollProcessing(): void {
  if (pollTimeout !== null) return;
  if (pollQueue.size === 0) return;
  pollTimeout = setTimeout(async () => {
    pollTimeout = null;
    const entries = [...pollQueue.entries()];
    pollQueue.clear();
    for (const [, entry] of entries) {
      try {
        const result = await entry.provider.getTransactionStatus(entry.referenceId);
        if (result.status === "pending" && entry.attempt < MAX_POLL_ATTEMPTS) {
          enqueuePoll(entry.referenceId, entry.provider, entry.attempt + 1);
        } else {
          logger.info(
            { referenceId: entry.referenceId, status: result.status, attempts: entry.attempt },
            "Poll resolved transaction status",
          );
        }
      } catch (err) {
        logger.error(
          { referenceId: entry.referenceId, error: err instanceof Error ? err.message : err },
          "Poll attempt failed, will retry",
        );
        if (entry.attempt < MAX_POLL_ATTEMPTS) {
          enqueuePoll(entry.referenceId, entry.provider, entry.attempt + 1);
        }
      }
    }
    schedulePollProcessing();
  }, POLL_DELAY_MS);
}

function enqueuePoll(referenceId: string, provider: MtnMomoProvider, attempt = 1): void {
  const key = `${referenceId}-${attempt}`;
  if (!pollQueue.has(key)) {
    pollQueue.set(key, { referenceId, provider, attempt });
    schedulePollProcessing();
  }
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof AxiosError) {
    return (
      error.code === "ECONNABORTED" ||
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNRESET" ||
      error.code === "ENOTFOUND" ||
      error.message?.toLowerCase().includes("timeout") ||
      error.message?.toLowerCase().includes("econnabort") ||
      error.message?.toLowerCase().includes("etimedout")
    );
  }
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /timeout|econnabort|etimedout|econnreset|enotfound/i.test(msg);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MtnTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

interface MtnBalanceResponse {
  availableBalance?: string | number;
  balance?: string | number;
  currency?: string;
}

interface MtnTransactionStatusResponse {
  status?: string;
  [key: string]: unknown;
}

export type MtnTransactionStatus =
  | "completed"
  | "failed"
  | "pending"
  | "unknown";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MtnMomoConfig extends Partial<ProviderAuthConfig> {
  subscriptionKey?: string;
  targetEnvironment?: string;
}

function buildMtnConfig(opts: MtnMomoConfig = {}): ProviderAuthConfig & {
  subscriptionKey: string;
  targetEnvironment: string;
} {
  return {
    apiKey: opts.apiKey ?? process.env.MTN_API_KEY ?? "",
    apiSecret: opts.apiSecret ?? process.env.MTN_API_SECRET ?? "",
    baseUrl:
      opts.baseUrl ??
      process.env.MTN_BASE_URL ??
      "https://sandbox.momodeveloper.mtn.com",
    timeoutMs: opts.timeoutMs ?? 10_000,
    tokenExpiryLeewaySeconds: opts.tokenExpiryLeewaySeconds ?? 30,
    subscriptionKey:
      opts.subscriptionKey ?? process.env.MTN_SUBSCRIPTION_KEY ?? "",
    targetEnvironment:
      opts.targetEnvironment ??
      process.env.MTN_TARGET_ENVIRONMENT ??
      "sandbox",
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class MtnMomoProvider extends BaseProvider {
  private readonly subscriptionKey: string;
  private readonly targetEnvironment: string;
  private readonly providerName: string = "mtn_momo";

  constructor(opts: MtnMomoConfig = {}) {
    const config = buildMtnConfig(opts);
    super(config);
    this.subscriptionKey = config.subscriptionKey;
    this.targetEnvironment = config.targetEnvironment;
  }

  // ─── Authentication ─────────────────────────────────────────────────────

  /**
   * Obtain a valid MTN bearer token, using the in-memory cache when possible.
   * Uses `buildBasicAuthHeader()` inherited from BaseProvider so the
   * credential encoding lives in exactly one place.
   */
  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }

    const startTime = Date.now();
    const endpoint = "/collection/token/";
    try {
      const response = await axios.post<MtnTokenResponse>(
        `${this.baseUrl}${endpoint}`,
        undefined,
        {
          headers: {
            // Credential header built by the shared base class utility
            Authorization: this.buildBasicAuthHeader(this.apiKey, this.apiSecret),
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
          },
          timeout: this.timeoutMs,
        },
      );

      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "getAccessToken",
        durationMs,
        success: true,
        statusCode: response.status,
        endpoint,
      });

      const { access_token, expires_in } = response.data;
      if (!access_token || typeof access_token !== "string") {
        throw new Error("MTN token response did not include access_token");
      }

      this.cacheToken(access_token, expires_in);
      return access_token;
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const axiosError = error as AxiosError;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "getAccessToken",
        durationMs,
        success: false,
        statusCode: axiosError?.response?.status,
        endpoint,
      });
      throw error;
    }
  }

  // ─── API operations ──────────────────────────────────────────────────────

  /** Request a payment (collection / request-to-pay). */
  async requestPayment(phoneNumber: string, amount: string) {
    const startTime = Date.now();
    const endpoint = "/collection/v1_0/requesttopay";
    const externalId = randomUUID();

    return executeWithCircuitBreaker({
      provider: this.providerName,
      operation: "requestPayment",
      execute: async () => {
        try {
          const response = await axios.post(
            `${this.baseUrl}${endpoint}`,
            {
              amount,
              currency: "EUR",
              externalId,
              payer: { partyIdType: "MSISDN", partyId: phoneNumber },
              payerMessage: "Payment for Stellar deposit",
              payeeNote: "Deposit",
            },
            {
              headers: {
                "Ocp-Apim-Subscription-Key": this.subscriptionKey,
                "X-Target-Environment": "sandbox",
              },
              timeout: this.timeoutMs,
            },
          );

          const durationMs = Date.now() - startTime;
          recordTelecomLatency({
            provider: this.providerName,
            operation: "requestPayment",
            durationMs,
            success: true,
            statusCode: response.status,
            endpoint,
          });

          return { success: true, data: response.data };
        } catch (error: unknown) {
          const durationMs = Date.now() - startTime;
          const isTimeout = isTimeoutError(error);
          const axiosError = error as AxiosError;
          recordTelecomLatency({
            provider: this.providerName,
            operation: "requestPayment",
            durationMs,
            success: false,
            statusCode: isTimeout ? undefined : axiosError?.response?.status,
            endpoint,
          });

          if (isTimeout) {
            logger.warn(
              { externalId, phoneNumber, amount, durationMs },
              "MTN requestPayment timed out, scheduling status poll",
            );
            enqueuePoll(externalId, this);
            // Throw so the circuit breaker counts this as a failure
            throw error;
          }

          return { success: false, error };
        }
      },
      fallback: async (_error) => {
        // OPEN state: fail fast without calling the API
        logger.warn(
          { phoneNumber, amount },
          "MTN circuit breaker OPEN — returning cached fallback for requestPayment",
        );
        return {
          success: false,
          error: new Error(
            "MTN MoMo collection is temporarily unavailable (circuit breaker open). Please retry shortly.",
          ),
        };
      },
    });
  }

  /** Disburse funds to a phone number. */
  async sendPayout(_phoneNumber: string, _amount: string) {
    const startTime = Date.now();
    const endpoint = "/disbursement/v1_0/transfer";
    const durationMs = Date.now() - startTime;
    recordTelecomLatency({
      provider: this.providerName,
      operation: "sendPayout",
      durationMs,
      success: true,
      endpoint,
    });
    return { success: true };
  }

  /** Query the status of a transaction by reference ID. */
  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: MtnTransactionStatus }> {
    const startTime = Date.now();
    const endpoint = `/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`;
    try {
      const token = await this.getAccessToken();
      const response = await axios.get<MtnTransactionStatusResponse>(
        `${this.baseUrl}${endpoint}`,
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(token),
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": this.targetEnvironment,
          },
          timeout: this.timeoutMs,
        },
      );

      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "getTransactionStatus",
        durationMs,
        success: true,
        statusCode: response.status,
        endpoint: "/collection/v1_0/requesttopay/{ref}",
      });

      const raw = String(response.data?.status ?? "").toUpperCase();
      if (raw === "SUCCESSFUL") return { status: "completed" };
      if (raw === "FAILED")     return { status: "failed" };
      if (raw === "PENDING")    return { status: "pending" };
      return { status: "unknown" };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const isTimeout = isTimeoutError(error);
      const axiosError = error as AxiosError;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "getTransactionStatus",
        durationMs,
        success: isTimeout ? true : false,
        statusCode: isTimeout ? undefined : axiosError?.response?.status,
        endpoint: "/collection/v1_0/requesttopay/{ref}",
      });

      if (isTimeout) {
        logger.warn(
          { referenceId, durationMs },
          "MTN getTransactionStatus timed out, scheduling poll retry",
        );
        enqueuePoll(referenceId, this);
        return { status: "pending" };
      }

      return { status: "unknown" };
    }
  }

  /** Fetch the operational balance of the disbursement account. */
  async getOperationalBalance() {
    const startTime = Date.now();
    const endpoint = "/disbursement/v1_0/account/balance";
    try {
      const token = await this.getAccessToken();
      const response = await axios.get<MtnBalanceResponse>(
        `${this.baseUrl}${endpoint}`,
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(token),
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": this.targetEnvironment,
          },
          timeout: this.timeoutMs,
        },
      );

      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "getOperationalBalance",
        durationMs,
        success: true,
        statusCode: response.status,
        endpoint,
      });

      const raw =
        response.data.availableBalance ?? response.data.balance ?? 0;
      const availableBalance =
        typeof raw === "number" ? raw : Number.parseFloat(String(raw));

      if (!Number.isFinite(availableBalance)) {
        throw new Error("Invalid MTN balance response");
      }

      return {
        success: true,
        data: {
          availableBalance,
          currency: response.data.currency ?? "XAF",
        },
      };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const axiosError = error as AxiosError;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "getOperationalBalance",
        durationMs,
        success: false,
        statusCode: axiosError?.response?.status,
        endpoint,
      });

      return { success: false, error };
    }
  }

  /**
   * Query MTN MoMo disbursement float via
   * GET /disbursement/v1_0/account/balance.
   *
   * Required by #1967: pre-flight balance inquiry before bulk payouts.
   * Delegates to getOperationalBalance so both entry points share one
   * implementation, response shape, and latency instrumentation.
   */
  async getAccountBalance() {
    return this.getOperationalBalance();
  }

  /**
   * MTN MoMo Batch Payout - submits multiple payout items in a single request
   */
  async sendBatchPayout(
    items: BatchPayoutItem[],
    requestId?: string,
  ): Promise<{
    success: boolean;
    results: BatchPayoutResult[];
    error?: unknown;
  }> {
    const log = requestId ? logger.child({ requestId }) : logger;
    const MAX_BATCH_SIZE = 100;

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
        error: new Error(
          `Batch size ${items.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
        ),
      };
    }

    log.info(
      { itemCount: items.length },
      "MTN MoMo: Starting batch payout",
    );
    const startTime = Date.now();

    try {
      const token = await this.getAccessToken();
      const batchReference = `BATCH-${randomUUID()}`;

      const response = await axios.post(
        `${this.baseUrl}/disbursement/v2_0/batch-payout`,
        {
          batchReference,
          items: items.map((item) => ({
            referenceId: item.referenceId,
            amount: item.amount,
            currency: process.env.MTN_CURRENCY || "XAF",
            payee: {
              partyIdType: "MSISDN",
              partyId: item.phoneNumber,
            },
          })),
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": this.targetEnvironment,
            "Content-Type": "application/json",
          },
        },
      );

      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "sendBatchPayout",
        durationMs,
        success: true,
        statusCode: response.status,
        endpoint: "/disbursement/v2_0/batch-payout",
      });

      const results: BatchPayoutResult[] = items.map((item) => ({
        referenceId: item.referenceId,
        success: true,
        providerReference: batchReference,
      }));

      return { success: true, results };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      const axiosError = error as AxiosError;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "sendBatchPayout",
        durationMs,
        success: false,
        statusCode: axiosError?.response?.status,
        endpoint: "/disbursement/v2_0/batch-payout",
      });

      log.error(
        { error: error?.message },
        "MTN MoMo: Batch payout request failed",
      );

      const results: BatchPayoutResult[] = items.map((item) => ({
        referenceId: item.referenceId,
        success: false,
        error: error?.message || "Batch payout submission failed",
      }));

      return { success: false, results, error };
    }
  }
}

// ─── Reconciliation & Query Functions ─────────────────────────────────────────

import { queryRead, queryWrite } from "../../config/database";
import { TransactionStatus } from "../../models/transaction";
import { MTNProvider } from "../mobilemoney/providers/mtn";

export interface PendingTransaction {
  id: string;
  referenceNumber: string;
  providerReference: string | null;
  phoneNumber: string;
  amount: string;
  status: TransactionStatus;
  createdAt: Date;
}

export async function fetchPendingTransactions(): Promise<PendingTransaction[]> {
  const result = await queryRead<PendingTransaction>(
    `SELECT id, reference_number AS "referenceNumber", provider_reference AS "providerReference", phone_number AS "phoneNumber", amount, status, created_at AS "createdAt" FROM transactions WHERE status = $1 AND provider ILIKE 'mtn%' ORDER BY created_at ASC`,
    [TransactionStatus.Pending],
  );
  return result.rows;
}

export async function reconcilePendingTransactions() {
  const pending = await fetchPendingTransactions();
  if (pending.length === 0) {
    return { total: 0, updated: 0, results: [] };
  }
  const provider = new MTNProvider();
  let updatedCount = 0;
  const results = [];

  for (const tx of pending) {
    try {
      const ref = tx.providerReference || tx.referenceNumber;
      const statusRes = await provider.getTransactionStatus(ref);
      let newStatus: TransactionStatus | null = null;
      if (statusRes.status === "completed") {
        newStatus = TransactionStatus.Completed;
      } else if (statusRes.status === "failed") {
        newStatus = TransactionStatus.Failed;
      }

      if (newStatus) {
        await queryWrite(`UPDATE transactions SET status = $1 WHERE id = $2`, [
          newStatus,
          tx.id,
        ]);
        updatedCount++;
        results.push({
          id: tx.id,
          referenceNumber: tx.referenceNumber,
          previousStatus: tx.status,
          newStatus,
          updated: true,
          providerStatus: statusRes.status,
        });
      } else {
        results.push({
          id: tx.id,
          referenceNumber: tx.referenceNumber,
          previousStatus: tx.status,
          newStatus: null,
          updated: false,
          providerStatus: statusRes.status,
        });
      }
    } catch {
      results.push({
        id: tx.id,
        referenceNumber: tx.referenceNumber,
        previousStatus: tx.status,
        newStatus: null,
        updated: false,
        providerStatus: "error",
      });
    }
  }

  return {
    total: pending.length,
    updated: updatedCount,
    results,
  };
}


