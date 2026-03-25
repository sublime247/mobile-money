import axios, { AxiosInstance } from "axios";

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
      console.error("Airtel auth failed", error);
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

        // Retry only for transient errors
        if (
          ((err as { response?: { status?: number } }).response?.status &&
            (err as { response: { status: number } }).response.status >= 500) ||
          (err as { code?: string }).code === "ECONNABORTED"
        ) {
          console.warn(`Retrying Airtel request (${i + 1})`);
          await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
          continue;
        }

        throw err;
      }
    }

    throw lastError;
  }

  /**
   * =========================
   * REQUEST PAYMENT (COLLECTION)
   * =========================
   */
  async requestPayment(phoneNumber: string, amount: string) {
    const token = await this.authenticate();
    const reference = `AIRTEL-${Date.now()}`;

    return this.withRetry(async () => {
      try {
        const response = await this.client.post(
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

        return { success: true, data: response.data };
      } catch (error) {
        return { success: false, error };
      }
    });
  }

  /**
   * =========================
   * CHECK TRANSACTION STATUS
   * =========================
   */
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

  /**
   * =========================
   * PAYOUT (DISBURSEMENT)
   * =========================
   */
  async sendPayout(phoneNumber: string, amount: string) {
    const token = await this.authenticate();
    const reference = `AIRTEL-PAYOUT-${Date.now()}`;

    return this.withRetry(async () => {
      try {
        const response = await this.client.post(
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

        return { success: true, data: response.data };
      } catch (error) {
        return { success: false, error };
      }
    });
  }
}
