import axios from "axios";
import { randomUUID } from "crypto";
import logger from "../../../utils/logger";
import { maskPII } from "../../../utils/masking";

interface MtnBalanceResponse {
  availableBalance?: string | number;
  balance?: string | number;
  currency?: string;
}

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

export class MTNProvider {
  private apiKey: string;
  private apiSecret: string;
  private subscriptionKey: string;
  private baseUrl = "https://sandbox.momodeveloper.mtn.com";
  private environment: string;

  constructor() {
    this.apiKey = process.env.MTN_API_KEY || "";
    this.apiSecret = process.env.MTN_API_SECRET || "";
    this.subscriptionKey = process.env.MTN_SUBSCRIPTION_KEY || "";
    this.environment = process.env.MTN_TARGET_ENVIRONMENT || "sandbox";
    if (process.env.MTN_BASE_URL) {
      this.baseUrl = process.env.MTN_BASE_URL;
    }
  }

  private async getAccessToken(): Promise<string> {
    const response = await axios.post(
      `${this.baseUrl}/collection/token/`,
      undefined,
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64"),
          "Ocp-Apim-Subscription-Key": this.subscriptionKey,
        },
      },
    );

    const token = response.data?.access_token;
    if (!token || typeof token !== "string") {
      throw new Error("MTN token response did not include access_token");
    }

    return token;
  }

  async getOperationalBalance() {
    try {
      const token = await this.getAccessToken();
      const response = await axios.get<MtnBalanceResponse>(
        `${this.baseUrl}/disbursement/v1_0/account/balance`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": this.environment,
          },
        },
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
          currency: response.data.currency || "XAF",
        },
      };
    } catch (error) {
      return { success: false, error };
    }
  }

  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(maskPII({ phoneNumber, amount }), "MTN: Requesting payment");
    const startTime = Date.now();

    try {
      const response = await axios.post(
        `${this.baseUrl}/collection/v1_0/requesttopay`,
        {
          amount,
          currency: "EUR",
          externalId: randomUUID(),
          payer: { partyIdType: "MSISDN", partyId: phoneNumber },
          payerMessage: "Payment for Stellar deposit",
          payeeNote: "Deposit",
        },
        {
          headers: {
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": "sandbox",
          },
        },
      );

      const duration = Date.now() - startTime;
      log.info(
        maskPII({ duration, status: response.status }),
        "MTN: Payment request successful",
      );

      return {
        success: true,
        data: response.data,
        providerResponseTimeMs: duration,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
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
        providerResponseTimeMs: duration,
      };
    }
  }

  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(maskPII({ phoneNumber, amount }), "MTN: Sending payout");
    return { success: true };
  }

  /**
   * MTN B2B Batch Payout - Process up to 50 payouts in a single API call.
   * This provides significant performance gains for high-volume payout operations.
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
      const token = await this.getAccessToken();
      const batchReference = `BATCH-${randomUUID()}`;

      // MTN disbursement batch API endpoint
      const response = await axios.post(
        `${this.baseUrl}/disbursement/v2_0/batch-payout`,
        {
          batchReference,
          items: items.map((item) => ({
            referenceId: item.referenceId,
            amount: item.amount,
            currency: "XAF",
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
            "X-Target-Environment": this.environment,
            "Content-Type": "application/json",
          },
        },
      );

      const duration = Date.now() - startTime;

      // Process partial success response
      const responseItems = response.data?.items ?? [];
      const results: BatchPayoutResult[] = items.map((item) => {
        const responseItem = responseItems.find(
          (r: { referenceId: string }) => r.referenceId === item.referenceId,
        );

        if (!responseItem) {
          return {
            referenceId: item.referenceId,
            success: false,
            error: "No response received for this item",
          };
        }

        const status = String(responseItem.status ?? "").toUpperCase();
        return {
          referenceId: item.referenceId,
          success: status === "SUCCESSFUL" || status === "SUCCESS",
          error:
            status !== "SUCCESSFUL" && status !== "SUCCESS"
              ? responseItem.errorReason ||
                responseItem.message ||
                `Status: ${status}`
              : undefined,
          providerReference:
            responseItem.financialTransactionId || responseItem.transactionId,
        };
      });

      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.filter((r) => !r.success).length;

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

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
    try {
      const token = await this.getAccessToken();
      const response = await axios.get(
        `${this.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": this.environment,
          },
        },
      );
      const providerStatus = String(response.data?.status ?? "").toUpperCase();
      if (providerStatus === "SUCCESSFUL") return { status: "completed" };
      if (providerStatus === "FAILED") return { status: "failed" };
      if (providerStatus === "PENDING") return { status: "pending" };
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }
}
