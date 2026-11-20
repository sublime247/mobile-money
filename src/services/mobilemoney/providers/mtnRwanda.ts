import type { AxiosInstance, AxiosError, AxiosResponse } from "axios";
import { providerHttp } from "../../providerStatus";
import logger from "../../../utils/logger";
import { maskPII } from "../../../utils/masking";
import { formatPhoneForProvider } from "../../../utils/phoneUtils";

const http = providerHttp("mtn-rwanda");

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface MTNRwandaResponse {
  status: string;
  transactionId?: string;
  errorDescription?: string;
  amount?: number;
  currency?: string;
}

interface MTNRwandaCallbackPayload {
  transactionId: string;
  status: string;
  amount: number;
  currency: string;
  phone: string;
  timestamp: number;
  signature: string;
}

interface MTNRwandaProviderConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  sandboxBaseUrl: string;
  currency: string; // RWF
  country: string; // RW
  callbackUrl: string;
  requestTimeoutMs: number;
  maxRetries: number;
}

export class MTNRwandaProvider {
  private client: AxiosInstance;
  private config: MTNRwandaProviderConfig;

  constructor(config: MTNRwandaProviderConfig) {
    this.config = config;
    this.client = http.create({
      baseURL: config.sandboxBaseUrl || config.baseUrl,
      timeout: config.requestTimeoutMs || 30000,
      headers: {
        "Content-Type": "application/json",
        "X-Reference-Id": this.generateReferenceId(),
      },
    });
  }

  private generateReferenceId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async initiatePayment(
    phone: string,
    amount: number,
    description: string
  ): Promise<{ transactionId: string; status: string }> {
    try {
      const response = await this.client.post<MTNRwandaResponse>(
        "/collection/v1_0/requesttopay",
        {
          amount: String(amount),
          currency: this.config.currency,
          externalId: this.generateReferenceId(),
          payer: {
            partyIdType: "MSISDN",
            partyId: formatPhoneForProvider(phone, "RW"),
          },
          payerMessage: description,
          payeeNote: "Payment processed via Momo API",
          callbackUrl: this.config.callbackUrl,
        },
        {
          auth: {
            username: this.config.apiKey,
            password: this.config.apiSecret,
          },
        }
      );

      logger.info(`MTN Rwanda payment initiated: ${maskPII(phone)}`);
      return {
        transactionId: response.data.transactionId || this.generateReferenceId(),
        status: "pending",
      };
    } catch (error) {
      logger.error(`MTN Rwanda payment initiation failed: ${error}`);
      throw new Error(`Failed to initiate MTN Rwanda payment: ${error}`);
    }
  }

  async checkTransactionStatus(transactionId: string): Promise<string> {
    try {
      const response = await this.client.get<MTNRwandaResponse>(
        `/collection/v1_0/requesttopay/${transactionId}`,
        {
          auth: {
            username: this.config.apiKey,
            password: this.config.apiSecret,
          },
        }
      );

      return response.data.status || "unknown";
    } catch (error) {
      logger.error(`Failed to check MTN Rwanda transaction status: ${error}`);
      return "error";
    }
  }

  async processPayout(
    phone: string,
    amount: number,
    description: string
  ): Promise<{ transactionId: string; status: string }> {
    try {
      const response = await this.client.post<MTNRwandaResponse>(
        "/disbursement/v1_0/transfer",
        {
          amount: String(amount),
          currency: this.config.currency,
          externalId: this.generateReferenceId(),
          payee: {
            partyIdType: "MSISDN",
            partyId: formatPhoneForProvider(phone, "RW"),
          },
          payerMessage: description,
          payeeNote: "Payout processed via Momo API",
          callbackUrl: this.config.callbackUrl,
        },
        {
          auth: {
            username: this.config.apiKey,
            password: this.config.apiSecret,
          },
        }
      );

      logger.info(`MTN Rwanda payout initiated: ${maskPII(phone)}`);
      return {
        transactionId: response.data.transactionId || this.generateReferenceId(),
        status: "pending",
      };
    } catch (error) {
      logger.error(`MTN Rwanda payout failed: ${error}`);
      throw new Error(`Failed to initiate MTN Rwanda payout: ${error}`);
    }
  }

  verifyCallbackSignature(
    payload: string,
    signature: string,
    secret: string
  ): boolean {
    try {
      const crypto = require("crypto");
      const hash = crypto
        .createHmac("sha256", secret)
        .update(payload)
        .digest("base64");
      return hash === signature;
    } catch (error) {
      logger.error(`Signature verification failed: ${error}`);
      return false;
    }
  }

  async getAccountBalance(): Promise<number> {
    try {
      const response = await this.client.get<{ balance: number }>(
        "/collection/v1_0/account/balance",
        {
          auth: {
            username: this.config.apiKey,
            password: this.config.apiSecret,
          },
        }
      );
      return response.data.balance || 0;
    } catch (error) {
      logger.error(`Failed to get MTN Rwanda balance: ${error}`);
      return 0;
    }
  }
}

export default MTNRwandaProvider;
