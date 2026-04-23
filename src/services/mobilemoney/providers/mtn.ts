import axios from "axios";
import { randomUUID } from "crypto";

interface MtnBalanceResponse {
  availableBalance?: string | number;
  balance?: string | number;
  currency?: string;
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

  async requestPayment(phoneNumber: string, amount: string) {
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

      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error };
    }
  }

  async checkStatus(reference: string) {
    try {
      const token = await this.getAccessToken();
      const response = await axios.get(
        `${this.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(reference)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": this.environment,
          },
        },
      );

      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error };
    }
  }

  async sendPayout(_phoneNumber: string, _amount: string) {
    return { success: true };
  }
}
