import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import logger from "../../../utils/logger";

function encrypt(data: string, publicKeyPem: string): string {
  if (!publicKeyPem) {
    throw new Error("Vodacom Provider: Public key is missing or empty");
  }
  
  let formattedKey = publicKeyPem.trim();
  if (!formattedKey.includes("-----BEGIN PUBLIC KEY-----")) {
    formattedKey = `-----BEGIN PUBLIC KEY-----\n${formattedKey}\n-----END PUBLIC KEY-----`;
  }

  const buffer = Buffer.from(data);
  const encrypted = crypto.publicEncrypt(
    {
      key: formattedKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    buffer
  );
  return encrypted.toString("base64");
}

export class VodacomProvider {
  private apiKey: string;
  private publicKey: string;
  private serviceProviderCode: string;
  private baseUrl: string;
  private market: string;
  private currency: string;
  private client: AxiosInstance;
  
  private sessionToken: string | null = null;
  private sessionTokenExpiry = 0;

  constructor() {
    this.apiKey = process.env.VODACOM_API_KEY || "";
    this.publicKey = process.env.VODACOM_PUBLIC_KEY || "";
    this.serviceProviderCode = process.env.VODACOM_SERVICE_PROVIDER_CODE || "000000";
    this.baseUrl = process.env.VODACOM_BASE_URL || "https://sandbox.openapi.m-pesa.com";
    this.market = process.env.VODACOM_MARKET || "vodacomTZN";
    this.currency = process.env.VODACOM_CURRENCY || "TZS";
    
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": "*",
      }
    });
  }

  private async getAccessToken(): Promise<string> {
    if (this.sessionToken && Date.now() < this.sessionTokenExpiry) {
      return this.sessionToken;
    }

    if (!this.apiKey || !this.publicKey) {
      throw new Error("Vodacom Provider: VODACOM_API_KEY and VODACOM_PUBLIC_KEY must be configured");
    }

    const encryptedKey = encrypt(this.apiKey, this.publicKey);
    
    const response = await this.client.get(
      `/${this.market}/getSession/`,
      {
        headers: {
          Authorization: `Bearer ${encryptedKey}`,
        }
      }
    );

    const sessionID = response.data?.output_SessionID;
    const responseCode = response.data?.output_ResponseCode;

    if (responseCode !== "INS-0" || !sessionID) {
      throw new Error(`Vodacom getSession failed with code ${responseCode}: ${response.data?.output_ResponseDesc || "Unknown error"}`);
    }

    this.sessionToken = sessionID;
    this.sessionTokenExpiry = Date.now() + 19 * 60 * 1000;

    return this.sessionToken;
  }

  async requestPayment(phoneNumber: string, amount: string, requestId?: string) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info({ phoneNumber, amount }, "Vodacom: Requesting payment");
    const startTime = Date.now();

    try {
      const token = await this.getAccessToken();
      const encryptedToken = encrypt(token, this.publicKey);
      const reference = `VODA-C2B-${Date.now()}`;

      const response = await this.client.post(
        `/${this.market}/c2bPayment/singleStage/`,
        {
          input_Amount: amount,
          input_Country: "TZN",
          input_Currency: this.currency,
          input_CustomerMSISDN: phoneNumber,
          input_ServiceProviderCode: this.serviceProviderCode,
          input_ThirdPartyConversationID: reference,
          input_TransactionReference: reference,
          input_PurchasedItemsDesc: "Stellar Deposit",
        },
        {
          headers: {
            Authorization: `Bearer ${encryptedToken}`,
          }
        }
      );

      const duration = Date.now() - startTime;
      const code = response.data?.output_ResponseCode;
      
      if (code === "INS-0") {
        log.info({ duration, transactionId: response.data?.output_TransactionID }, "Vodacom: Payment request successful");
        return {
          success: true,
          data: response.data,
          providerResponseTimeMs: duration
        };
      } else {
        throw new Error(`C2B failed with code ${code}: ${response.data?.output_ResponseDesc || "Unknown error"}`);
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      log.error({ duration, error: error.message }, "Vodacom: Payment request failed");
      return {
        success: false,
        error: error,
        providerResponseTimeMs: duration
      };
    }
  }

  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info({ phoneNumber, amount }, "Vodacom: Sending payout");
    const startTime = Date.now();

    try {
      const token = await this.getAccessToken();
      const encryptedToken = encrypt(token, this.publicKey);
      const reference = `VODA-B2C-${Date.now()}`;

      const response = await this.client.post(
        `/${this.market}/b2cPayment/singleStage/`,
        {
          input_Amount: amount,
          input_Country: "TZN",
          input_Currency: this.currency,
          input_CustomerMSISDN: phoneNumber,
          input_ServiceProviderCode: this.serviceProviderCode,
          input_ThirdPartyConversationID: reference,
          input_TransactionReference: reference,
          input_PurchasedItemsDesc: "Stellar Payout",
        },
        {
          headers: {
            Authorization: `Bearer ${encryptedToken}`,
          }
        }
      );

      const duration = Date.now() - startTime;
      const code = response.data?.output_ResponseCode;

      if (code === "INS-0") {
        log.info({ duration, transactionId: response.data?.output_TransactionID }, "Vodacom: Payout request successful");
        return {
          success: true,
          data: response.data,
          providerResponseTimeMs: duration
        };
      } else {
        throw new Error(`B2C failed with code ${code}: ${response.data?.output_ResponseDesc || "Unknown error"}`);
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      log.error({ duration, error: error.message }, "Vodacom: Payout request failed");
      return {
        success: false,
        error: error,
        providerResponseTimeMs: duration
      };
    }
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
    try {
      const token = await this.getAccessToken();
      const encryptedToken = encrypt(token, this.publicKey);

      const response = await this.client.get(
        `/${this.market}/queryTransactionStatus/`,
        {
          headers: {
            Authorization: `Bearer ${encryptedToken}`,
          },
          params: {
            input_QueryReference: referenceId,
            input_ServiceProviderCode: this.serviceProviderCode,
            input_ThirdPartyConversationID: `VODA-QUERY-${Date.now()}`,
          }
        }
      );

      const code = response.data?.output_ResponseCode;
      if (code === "INS-0") {
        const txStatus = String(response.data?.output_TransactionStatus || "").toUpperCase();
        if (txStatus === "SUCCESSFUL" || txStatus === "SUCCESS" || txStatus === "COMPLETED") {
          return { status: "completed" };
        } else if (txStatus === "FAILED" || txStatus === "FAIL") {
          return { status: "failed" };
        } else {
          return { status: "pending" };
        }
      }
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }
}
