import axios, { AxiosInstance, AxiosError } from "axios";
import logger from "../../../utils/logger";

// This interface is now used in the methods below
interface AirtelResponse {
  data?: {
    transaction?: {
      status: string;
      id: string;
    };
  };
  status?: {
    success: boolean;
    code: string;
  };
}

interface AirtelBalanceResponse {
  data?: {
    balance?: string | number;
    availableBalance?: string | number;
    currency?: string;
  };
  balance?: string | number;
  availableBalance?: string | number;
  currency?: string;
}

export class AirtelService {
  private client: AxiosInstance;
  private token: string | null = null;
  private tokenExpiry: number = 0;

  constructor() {
    this.client = axios.create({
      baseURL: process.env.AIRTEL_BASE_URL,
      timeout: 10000,
    });
  }

  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    try {
      const response = await this.client.post("/auth/oauth2/token", null, {
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.AIRTEL_API_KEY}:${process.env.AIRTEL_API_SECRET}`,
            ).toString("base64"),
        },
      });

      this.token = response.data.access_token;
      this.tokenExpiry = Date.now() + response.data.expires_in * 1000;

      return this.token!;
    } catch (error) {
      logger.error({ error }, "Airtel auth failed");
      throw new Error("Airtel authentication failed");
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    let lastError: Error | undefined;

    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        const axiosError = err as AxiosError;

        if (axiosError.response?.status === 401) {
          this.token = null;
        }

        // Retry only for transient errors
        if (
          ((err as { response?: { status?: number } }).response?.status &&
            (err as { response: { status: number } }).response.status >= 500) ||
          (err as { code?: string }).code === "ECONNABORTED"
        ) {
          logger.warn({ attempt: i + 1 }, "Retrying Airtel request");
          await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
          continue;
        }

        throw err;
      }
    }

    throw lastError!;
  }

  /**
   * =========================
   * REQUEST PAYMENT (COLLECTION)
   * =========================
   */
  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info({ phoneNumber, amount }, "Airtel: Requesting payment");
    const startTime = Date.now();

    const token = await this.authenticate();
    const reference = `AIRTEL-${Date.now()}`;

    return this.withRetry(async () => {
      try {
        // Apply AirtelResponse here
        const response = await this.client.post<AirtelResponse>(
          "/merchant/v1/payments/",
          {
            reference,
            subscriber: {
              country: "NG",
              currency: "NGN",
              msisdn: phoneNumber,
            },
            transaction: {
              amount: parseFloat(amount),
              country: "NG",
              currency: "NGN",
              id: reference,
            },
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Country": "NG",
              "X-Currency": "NGN",
            },
          },
        );

        const duration = Date.now() - startTime;
        log.info(
          { duration, status: response.status },
          "Airtel: Payment request successful",
        );

        return {
          success: true,
          data: response.data,
          providerResponseTimeMs: duration,
        };
      } catch (error: any) {
        const duration = Date.now() - startTime;
        log.error(
          {
            duration,
            error: error.message,
            response: error.response?.data,
          },
          "Airtel: Payment request failed",
        );
        return {
          success: false,
          error,
          providerResponseTimeMs: duration,
        };
      }
    });
  }

  async getTransactionStatus(
    reference: string,
  ): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
    try {
      const result = await this.checkStatus(reference);
      if (!result.success) return { status: "unknown" };
      const txStatus = String(
        (result.data as AirtelResponse)?.data?.transaction?.status ?? "",
      ).toUpperCase();
      // Airtel status codes: TS = success, TF = failed, TP = pending
      if (txStatus === "TS") return { status: "completed" };
      if (txStatus === "TF") return { status: "failed" };
      if (txStatus === "TP") return { status: "pending" };
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  async checkStatus(reference: string) {
    const token = await this.authenticate();

    return this.withRetry(async () => {
      try {
        const response = await this.client.get(
          `/standard/v1/payments/${reference}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Country": "NG",
              "X-Currency": "NGN",
            },
          },
        );
        return { success: true, data: response.data };
      } catch (error) {
        return { success: false, error };
      }
    });
  }

  async getOperationalBalance() {
    const token = await this.authenticate();

    return this.withRetry(async () => {
      try {
        const response = await this.client.get<AirtelBalanceResponse>(
          "/standard/v1/users/balance",
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Country": process.env.AIRTEL_COUNTRY || "NG",
              "X-Currency": process.env.AIRTEL_CURRENCY || "NGN",
            },
          },
        );

        const rawBalance =
          response.data.data?.availableBalance ??
          response.data.data?.balance ??
          response.data.availableBalance ??
          response.data.balance ??
          0;

        const availableBalance =
          typeof rawBalance === "number"
            ? rawBalance
            : Number.parseFloat(String(rawBalance));

        if (!Number.isFinite(availableBalance)) {
          throw new Error("Invalid Airtel balance response");
        }

        return {
          success: true,
          data: {
            availableBalance,
            currency:
              response.data.data?.currency ||
              response.data.currency ||
              process.env.AIRTEL_CURRENCY ||
              "NGN",
          },
        };
      } catch (error) {
        return { success: false, error };
      }
    });
  }

  /**
   * =========================
   * PAYOUT (DISBURSEMENT)
   * =========================
   */
  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info({ phoneNumber, amount }, "Airtel: Sending payout");
    const startTime = Date.now();

    const token = await this.authenticate();
    const reference = `AIRTEL-PAYOUT-${Date.now()}`;

    return this.withRetry(async () => {
      try {
        // Apply AirtelResponse here
        const response = await this.client.post<AirtelResponse>(
          "/standard/v1/disbursements/",
          {
            reference,
            payee: {
              msisdn: phoneNumber,
            },
            transaction: {
              amount: parseFloat(amount),
              id: reference,
            },
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Country": "NG",
              "X-Currency": "NGN",
            },
          },
        );

        const duration = Date.now() - startTime;
        log.info(
          { duration, status: response.status },
          "Airtel: Payout successful",
        );

        return {
          success: true,
          data: response.data,
          providerResponseTimeMs: duration,
        };
      } catch (error: any) {
        const duration = Date.now() - startTime;
        log.error(
          {
            duration,
            error: error.message,
            response: error.response?.data,
          },
          "Airtel: Payout failed",
        );
        return {
          success: false,
          error,
          providerResponseTimeMs: duration,
        };
      }
    });
  }
}
