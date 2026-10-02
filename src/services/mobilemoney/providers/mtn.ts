/**
 * MTNProvider
 *
 * Extends BaseProvider so that the Basic-auth credential signature and
 * Bearer-token construction are inherited from the shared core config
 * class rather than being duplicated inline.
 *
 * Re-exported here for backwards compatibility — existing imports of
 * `MTNProvider` from this path continue to work unchanged.
 */

import axios from "axios";
import { randomUUID } from "crypto";
import { BaseProvider, ProviderAuthConfig } from "../../providers/baseProvider";
import { MomoAuthManager } from "../../../providers/mtn/momoAuth";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MtnTokenResponse {
  access_token: string;
  expires_in: number;
}
import logger from "../../../utils/logger";
import { maskPII } from "../../../utils/masking";
import {
  recordProviderRequestDuration,
  recordProviderErrorMetric,
} from "../../../utils/metrics";

interface MtnBalanceResponse {
  availableBalance?: string | number;
  balance?: string | number;
  currency?: string;
}

interface MtnBatchResponseItem {
  referenceId?: string;
  status?: string;
  errorReason?: string;
  message?: string;
  financialTransactionId?: string;
  transactionId?: string;
  phoneNumber?: string;
  msisdn?: string;
  amount?: string | number;
}

// ─── Config builder ───────────────────────────────────────────────────────────

/**
 * ISO-4217 currency for the deployment's MTN market. Cameroon (the primary
 * MoMo market bridged here) settles in Central African CFA francs — `XAF`.
 * Overridable via `MTN_CURRENCY` for other MTN markets (e.g. `UGX`, `GHS`).
 */
const DEFAULT_MTN_CURRENCY = "XAF";

/** Batch-payout polling defaults (overridable via env for tests / tuning). */
const DEFAULT_BATCH_POLL_MAX_ATTEMPTS = 10;
const DEFAULT_BATCH_POLL_DELAY_MS = 2_000;

/** Batch item statuses that still need another poll before they settle. */
const NON_TERMINAL_BATCH_STATUSES = new Set([
  "PENDING",
  "IN_PROGRESS",
  "PROCESSING",
  "ACCEPTED",
  "SUBMITTED",
]);

function buildConfig(): ProviderAuthConfig & {
  subscriptionKey: string;
  targetEnvironment: string;
  currency: string;
  batchPollMaxAttempts: number;
  batchPollDelayMs: number;
} {
  return {
    apiKey: process.env.MTN_API_KEY ?? "",
    apiSecret: process.env.MTN_API_SECRET ?? "",
    baseUrl:
      process.env.MTN_BASE_URL ?? "https://sandbox.momodeveloper.mtn.com",
    timeoutMs: 10_000,
    subscriptionKey: process.env.MTN_SUBSCRIPTION_KEY ?? "",
    targetEnvironment: process.env.MTN_TARGET_ENVIRONMENT ?? "sandbox",
    currency: process.env.MTN_CURRENCY ?? DEFAULT_MTN_CURRENCY,
    batchPollMaxAttempts: Number(
      process.env.MTN_BATCH_PAYOUT_MAX_ATTEMPTS ??
        DEFAULT_BATCH_POLL_MAX_ATTEMPTS,
    ),
    batchPollDelayMs: Number(
      process.env.MTN_BATCH_PAYOUT_POLL_DELAY_MS ?? DEFAULT_BATCH_POLL_DELAY_MS,
    ),
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

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

export class MTNProvider extends BaseProvider {
  protected readonly subscriptionKey: string;
  protected readonly environment: string;
  protected readonly currency: string;
  private readonly batchPollMaxAttempts: number;
  private readonly batchPollDelayMs: number;
  private readonly auth: MomoAuthManager;

  constructor() {
    const config = buildConfig();
    super(config);
    this.subscriptionKey = config.subscriptionKey;
    this.environment = config.targetEnvironment;
    this.currency = config.currency;
    this.batchPollMaxAttempts = config.batchPollMaxAttempts;
    this.batchPollDelayMs = config.batchPollDelayMs;
    this.auth = new MomoAuthManager({
      product: "collection",
      apiKey: this.apiKey,
      targetEnvironment: this.environment,
      fetchToken: () => this.requestNewToken(),
    });
  }

  // ─── Authentication ─────────────────────────────────────────────────────

  /**
   * Obtain a valid MTN bearer token. Tokens are shared across replicas via
   * Redis, refreshed before expiry under a distributed lock, and evicted on
   * 401 — see {@link MomoAuthManager}.
   */
  async getAccessToken(): Promise<string> {
    return this.auth.getToken();
  }

  /** Raw token exchange; only called by the auth manager's refresh leader. */
  private async requestNewToken() {
    const response = await axios.post<MtnTokenResponse>(
      `${this.baseUrl}/collection/token/`,
      undefined,
      {
        headers: {
          Authorization: this.buildBasicAuthHeader(this.apiKey, this.apiSecret),
          "Ocp-Apim-Subscription-Key": this.subscriptionKey,
        },
        timeout: this.timeoutMs,
      },
    );
    return {
      accessToken: response.data?.access_token,
      expiresIn: response.data?.expires_in,
    };
  }

  /** Run an authenticated MTN call, retrying once with a new token on 401. */
  private withAuth<T>(call: (token: string) => Promise<T>): Promise<T> {
    return this.auth.withAuthRetry(call, () => this.getAccessToken());
  }

  // ─── API operations ──────────────────────────────────────────────────────

  async getOperationalBalance() {
    try {
      const response = await this.withAuth((token) =>
        axios.get<MtnBalanceResponse>(
          `${this.baseUrl}/disbursement/v1_0/account/balance`,
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "Ocp-Apim-Subscription-Key": this.subscriptionKey,
              "X-Target-Environment": this.environment,
            },
          },
        ),
      );

      const availableRaw =
        response.data.availableBalance ?? response.data.balance ?? 0;
      const availableBalance =
        typeof availableRaw === "number"
          ? availableRaw
          : Number.parseFloat(String(availableRaw));

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
    } catch (error) {
      return { success: false, error };
    }
  }

  /**
   * Query MTN MoMo disbursement float via
   * GET /disbursement/v1_0/account/balance (#1967).
   * Alias over getOperationalBalance for pre-flight payout checks.
   */
  async getAccountBalance() {
    return this.getOperationalBalance();
  }

  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(maskPII({ phoneNumber, amount }), "MTN: Requesting payment");
    const startTime = Date.now();

    // MTN correlates a collection request by the `X-Reference-Id` header (a
    // UUID). It must be supplied on the POST and is the key used to poll the
    // transaction status afterwards, so it is surfaced to the caller.
    const referenceId = randomUUID();

    try {
      const response = await this.withAuth((token) =>
        axios.post(
          `${this.baseUrl}/collection/v1_0/requesttopay`,
          {
            amount,
            currency: this.currency,
            externalId: referenceId,
            payer: { partyIdType: "MSISDN", partyId: phoneNumber },
            payerMessage: "Payment for Stellar deposit",
            payeeNote: "Deposit",
          },
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "X-Reference-Id": referenceId,
              "Ocp-Apim-Subscription-Key": this.subscriptionKey,
              "X-Target-Environment": this.environment,
            },
          },
        ),
      );

      const duration = Date.now() - startTime;
      recordProviderRequestDuration("mtn", "requestPayment", duration / 1000);
      log.info(
        maskPII({ duration, status: response.status }),
        "MTN: Payment request successful",
      );

      return {
        success: true,
        data: response.data,
        referenceId,
        providerResponseTimeMs: duration,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      recordProviderRequestDuration("mtn", "requestPayment", duration / 1000);
      const errorType =
        error?.response?.status
          ? `HTTP_${error.response.status}`
          : (error?.code || error?.name || "REQUEST_PAYMENT_ERROR");
      recordProviderErrorMetric("mtn", String(errorType));
      log.error(
        maskPII({
          duration,
          error: error.message,
          response: error.response?.data,
        }),
        "MTN: Payment request failed",
      );
      return {
        success: false,
        error,
        referenceId,
        providerResponseTimeMs: duration,
      };
    }
  }

  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(maskPII({ phoneNumber, amount }), "MTN: Sending payout");
    const startTime = Date.now();
    try {
      const duration = Date.now() - startTime;
      recordProviderRequestDuration("mtn", "sendPayout", duration / 1000);
      return { success: true };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      recordProviderRequestDuration("mtn", "sendPayout", duration / 1000);
      const errorType =
        error?.response?.status
          ? `HTTP_${error.response.status}`
          : (error?.code || error?.name || "PAYOUT_ERROR");
      recordProviderErrorMetric("mtn", String(errorType));
      throw error;
    }
  }

  /**
   * MTN B2B Batch Payout - Process up to 100 payouts in a single API call.
   * Sends the batch then polls the MTN batch status endpoint until items
   * reach a terminal state or a timeout is reached. Individual item
   * failures are returned so callers can resolve them independently.
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
        error: new Error(
          `Batch size ${items.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
        ),
      };
    }

    log.info(
      maskPII({ itemCount: items.length }),
      "MTN: Starting batch payout",
    );
    const startTime = Date.now();

    try {
      const batchReference = `BATCH-${randomUUID()}`;

      // MTN disbursement batch API endpoint
      const response = await this.withAuth((token) =>
        axios.post(
          `${this.baseUrl}/disbursement/v2_0/batch-payout`,
          {
            batchReference,
            items: items.map((item) => ({
              referenceId: item.referenceId,
              amount: item.amount,
              currency: this.currency,
              payee: {
                partyIdType: "MSISDN",
                partyId: item.phoneNumber,
              },
            })),
          },
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "Ocp-Apim-Subscription-Key": this.subscriptionKey,
              "X-Target-Environment": this.environment,
              "Content-Type": "application/json",
            },
          },
        ),
      );

      // The disbursement batch endpoint returns 202 with a preliminary set of
      // per-item statuses; some may still be PENDING/IN_PROGRESS. Poll the
      // batch status endpoint until every item settles or attempts run out.
      const effectiveBatchRef = response.data?.batchReference ?? batchReference;
      const initialResponseItems = (response.data?.items ??
        []) as MtnBatchResponseItem[];
      let results = this.mapBatchResults(items, initialResponseItems);
      results = await this.pollBatchUntilSettled(
        items,
        results,
        initialResponseItems,
        effectiveBatchRef,
      );

      const duration = Date.now() - startTime;
      recordProviderRequestDuration("mtn", "sendBatchPayout", duration / 1000);
      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.filter((r) => !r.success).length;

      if (failureCount > 0 && successCount === 0) {
        recordProviderErrorMetric("mtn", "BATCH_PAYOUT_FAILED");
      }

      log.info(
        maskPII({
          duration,
          successCount,
          failureCount,
          batchReference,
        }),
        "MTN: Batch payout completed",
      );

      return {
        success: successCount > 0 || failureCount === 0,
        results,
        error:
          failureCount > 0 && successCount === 0
            ? new Error("All batch items failed")
            : undefined,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      recordProviderRequestDuration("mtn", "sendBatchPayout", duration / 1000);
      const errorType =
        error?.response?.status
          ? `HTTP_${error.response.status}`
          : (error?.code || error?.name || "BATCH_PAYOUT_ERROR");
      recordProviderErrorMetric("mtn", String(errorType));
      const errorMessage = error.message || "Batch payout request failed";

      log.error(
        maskPII({
          duration,
          error: errorMessage,
          itemCount: items.length,
        }),
        "MTN: Batch payout failed",
      );

      return {
        success: false,
        results: items.map((item) => ({
          referenceId: item.referenceId,
          success: false,
          error: errorMessage,
        })),
        error,
      };
    }
  }

  /**
   * Match an MTN batch-response entry to a submitted item. MTN echoes the
   * `referenceId` in most responses; when it is absent (some partner
   * environments only return it on the final callback) we fall back to
   * matching on the (phoneNumber, amount) pair the item was submitted with.
   */
  private findBatchResponseItem(
    item: BatchPayoutItem,
    responseItems: MtnBatchResponseItem[],
  ): MtnBatchResponseItem | undefined {
    const byRef = responseItems.find(
      (r) => r.referenceId != null && r.referenceId === item.referenceId,
    );
    if (byRef) return byRef;

    return responseItems.find(
      (r) =>
        (r.referenceId == null || r.referenceId === "") &&
        String(r.phoneNumber ?? r.msisdn ?? "") === item.phoneNumber &&
        String(r.amount ?? "") === String(item.amount),
    );
  }

  /** Count items whose latest known status still requires another poll. */
  private countUnsettledBatchItems(
    items: BatchPayoutItem[],
    responseItems: MtnBatchResponseItem[],
  ): number {
    return items.filter((item) => {
      const r = this.findBatchResponseItem(item, responseItems);
      return (
        r != null &&
        NON_TERMINAL_BATCH_STATUSES.has(String(r.status ?? "").toUpperCase())
      );
    }).length;
  }

  /**
   * Fold a set of MTN batch-response entries into caller-facing results,
   * preserving any already-known outcome for items missing from this batch
   * of entries.
   */
  private mapBatchResults(
    items: BatchPayoutItem[],
    responseItems: MtnBatchResponseItem[],
    previous?: BatchPayoutResult[],
  ): BatchPayoutResult[] {
    return items.map((item, idx) => {
      const responseItem = this.findBatchResponseItem(item, responseItems);

      if (!responseItem) {
        return (
          previous?.[idx] ?? {
            referenceId: item.referenceId,
            success: false,
            error: "No response received for this item",
          }
        );
      }

      const status = String(responseItem.status ?? "").toUpperCase();
      const success = status === "SUCCESSFUL" || status === "SUCCESS";

      return {
        referenceId: item.referenceId,
        success,
        error: success
          ? undefined
          : responseItem.errorReason ||
            responseItem.message ||
            `Status: ${status}`,
        providerReference:
          responseItem.financialTransactionId ||
          responseItem.transactionId ||
          previous?.[idx]?.providerReference,
      };
    });
  }

  /**
   * Poll the disbursement batch status endpoint until every item reaches a
   * terminal state, `batchPollMaxAttempts` is exhausted, or the status
   * request fails (in which case the best-known results are returned).
   */
  private async pollBatchUntilSettled(
    items: BatchPayoutItem[],
    initialResults: BatchPayoutResult[],
    initialResponseItems: MtnBatchResponseItem[],
    batchReference: string,
  ): Promise<BatchPayoutResult[]> {
    let results = initialResults;
    let latest = initialResponseItems;
    let attempts = 0;

    while (
      this.countUnsettledBatchItems(items, latest) > 0 &&
      attempts < this.batchPollMaxAttempts
    ) {
      attempts += 1;
      await new Promise((resolve) =>
        setTimeout(resolve, this.batchPollDelayMs),
      );

      let pollResponse;
      try {
        pollResponse = await this.withAuth((token) =>
          axios.get(
            `${this.baseUrl}/disbursement/v2_0/batch-payout/${encodeURIComponent(
              batchReference,
            )}`,
            {
              headers: {
                Authorization: this.buildBearerAuthHeader(token),
                "Ocp-Apim-Subscription-Key": this.subscriptionKey,
                "X-Target-Environment": this.environment,
              },
            },
          ),
        );
      } catch {
        break;
      }

      const pollItems = (pollResponse?.data?.items ??
        []) as MtnBatchResponseItem[];
      if (pollItems.length === 0) continue;

      latest = pollItems;
      results = this.mapBatchResults(items, latest, results);
    }

    return results;
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
    const startTime = Date.now();
    try {
      const response = await this.withAuth((token) =>
        axios.get(
          `${this.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`,
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "Ocp-Apim-Subscription-Key": this.subscriptionKey,
              "X-Target-Environment": this.environment,
            },
          },
        ),
      );

      const duration = Date.now() - startTime;
      recordProviderRequestDuration(
        "mtn",
        "getTransactionStatus",
        duration / 1000,
      );

      const providerStatus = String(response.data?.status ?? "").toUpperCase();
      if (providerStatus === "SUCCESSFUL") return { status: "completed" };
      if (providerStatus === "FAILED") {
        recordProviderErrorMetric("mtn", "TRANSACTION_FAILED");
        return { status: "failed" };
      }
      if (providerStatus === "PENDING") return { status: "pending" };
      return { status: "unknown" };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      recordProviderRequestDuration(
        "mtn",
        "getTransactionStatus",
        duration / 1000,
      );
      const errorType =
        error?.response?.status
          ? `HTTP_${error.response.status}`
          : (error?.code || error?.name || "STATUS_CHECK_ERROR");
      recordProviderErrorMetric("mtn", String(errorType));
      return { status: "unknown" };
    }
  }
}
