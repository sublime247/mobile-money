import { providerHttp } from "../../providerStatus";
import { randomUUID } from "crypto";
import logger from "../../../utils/logger";
import {
  resolveTigoHttpError,
  resolveTigoTransactionStatus,
} from "./errors/tigoErrorMatrix";

interface TigoBalanceResponse {
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

import { BaseProvider } from "../../providers/baseProvider";

const http = providerHttp("tigo");

export class TigoProvider extends BaseProvider {
  private environment: string;

  constructor() {
    super({
      apiKey: process.env.TIGO_API_KEY || "",
      apiSecret: process.env.TIGO_API_SECRET || "",
      baseUrl: process.env.TIGO_BASE_URL || "https://sandbox.tigo.com",
    });
    this.environment = process.env.TIGO_TARGET_ENVIRONMENT || "sandbox";
  }

  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }
    const response = await http.post(
      `${this.baseUrl}/oauth/token`,
      undefined,
      {
        headers: {
          ...this.buildOAuth2TokenRequestHeaders(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );
    const data = response.data as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error("Tigo token response missing access_token");
    }
    this.cacheToken(data.access_token, data.expires_in ?? 3600);
    return data.access_token;
  }

  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    const log = requestId ? logger.child({ requestId }) : logger;
    const start = Date.now();
    try {
      const token = await this.getAccessToken();
      const response = await http.post(
        `${this.baseUrl}/payments/collect`,
        {
          amount,
          currency: "XAF",
          externalId: randomUUID(),
          payer: { partyIdType: "MSISDN", partyId: phoneNumber },
          payerMessage: "Payment request",
          payeeNote: "MobileMoney",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Target-Environment": this.environment,
          },
        },
      );
      const duration = Date.now() - start;
      const httpErr = resolveTigoHttpError(response.status);
      if (httpErr) {
        log.error(
          { duration, status: response.status, errorCode: httpErr.errorCode },
          "Tigo: payment request failed",
        );
        return Object.assign(
          { success: false, providerResponseTimeMs: duration },
          {
            error: Object.assign(new Error(httpErr.message), {
              errorCode: httpErr.errorCode,
              retryable: httpErr.retryable,
            }),
          },
        );
      }
      log.info(
        { duration, status: response.status },
        "Tigo: payment request succeeded",
      );
      return {
        success: true,
        data: response.data,
        providerResponseTimeMs: duration,
      };
    } catch (err: any) {
      const duration = Date.now() - start;
      const httpStatus = err?.response?.status;
      const mapped = httpStatus ? resolveTigoHttpError(httpStatus) : undefined;
      if (mapped) {
        Object.assign(err, {
          errorCode: mapped.errorCode,
          retryable: mapped.retryable,
        });
      }
      log.error(
        { duration, error: err.message, errorCode: mapped?.errorCode },
        "Tigo: payment request failed",
      );
      return { success: false, error: err, providerResponseTimeMs: duration };
    }
  }

  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    const log = requestId ? logger.child({ requestId }) : logger;
    const start = Date.now();
    try {
      const token = await this.getAccessToken();
      const response = await http.post(
        `${this.baseUrl}/payments/disburse`,
        {
          amount,
          currency: "XAF",
          externalId: randomUUID(),
          payee: { partyIdType: "MSISDN", partyId: phoneNumber },
          payerMessage: "Payout",
          payeeNote: "MobileMoney",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Target-Environment": this.environment,
          },
        },
      );
      const duration = Date.now() - start;
      const httpErr = resolveTigoHttpError(response.status);
      if (httpErr) {
        log.error(
          { duration, status: response.status, errorCode: httpErr.errorCode },
          "Tigo: payout failed",
        );
        return Object.assign(
          { success: false, providerResponseTimeMs: duration },
          {
            error: Object.assign(new Error(httpErr.message), {
              errorCode: httpErr.errorCode,
              retryable: httpErr.retryable,
            }),
          },
        );
      }
      log.info({ duration, status: response.status }, "Tigo: payout succeeded");
      return {
        success: true,
        data: response.data,
        providerResponseTimeMs: duration,
      };
    } catch (err: any) {
      const duration = Date.now() - start;
      const httpStatus = err?.response?.status;
      const mapped = httpStatus ? resolveTigoHttpError(httpStatus) : undefined;
      if (mapped) {
        Object.assign(err, {
          errorCode: mapped.errorCode,
          retryable: mapped.retryable,
        });
      }
      log.error(
        { duration, error: err.message, errorCode: mapped?.errorCode },
        "Tigo: payout failed",
      );
      return { success: false, error: err, providerResponseTimeMs: duration };
    }
  }

  async getTransactionStatus(referenceId: string) {
    try {
      const token = await this.getAccessToken();
      const response = await http.get(
        `${this.baseUrl}/payments/status/${encodeURIComponent(referenceId)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Target-Environment": this.environment,
          },
        },
      );
      const rawStatus = String(response.data?.status ?? "");
      return resolveTigoTransactionStatus(rawStatus);
    } catch {
      return { status: "unknown" };
    }
  }

  async getOperationalBalance() {
    try {
      const token = await this.getAccessToken();
      const response = await http.get(`${this.baseUrl}/account/balance`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Target-Environment": this.environment,
        },
      });
      const raw =
        response.data?.availableBalance ?? response.data?.balance ?? 0;
      const available =
        typeof raw === "number" ? raw : Number.parseFloat(String(raw));
      return {
        success: true,
        data: {
          availableBalance: available,
          currency: response.data?.currency || "XAF",
        },
      };
    } catch (err) {
      return { success: false, error: err };
    }
  }
}
