import { AxiosError } from "axios";
import { providerHttp } from "../../services/providerStatus";
import crypto from "crypto";
import logger from "../../utils/logger";
import { maskPII } from "../../utils/masking";
import {
  MobileMoneyProvider,
  ProviderTransactionStatus,
} from "../../services/mobilemoney/mobileMoneyService";
import { resolveEcoCashErrorFromResponse } from "../../services/providers/errors/ecocashErrorMatrix";
import { scheduleEcoCashStatusPoll } from "../../queue/ecocashStatusPollingQueue";
import { retryWithJitter } from "../../utils/retryWithJitter";
import { createEcoCashAuth, EcoCashTokenManager } from "./auth";
import {
  EcoCashCurrency,
  SUPPORTED_ECOCASH_CURRENCIES,
  normalizeEcoCashCurrency,
  validateEcoCashPayment,
  validateEcoCashDisbursement,
} from "../../validators/ecocashValidator";

const http = providerHttp("ecocash");

export {
  EcoCashCurrency,
  SUPPORTED_ECOCASH_CURRENCIES,
  normalizeEcoCashCurrency,
};

export interface EcoCashDisbursementResult {
  success: boolean;
  data?: {
    transactionId: string;
    resultCode: string;
    resultDesc: string;
    settledCurrency?: EcoCashCurrency;
    exchangeRate?: number;
    receipt?: string;
  };
  error?: string;
  providerErrorCode?: string;
  retryable?: boolean;
}

export interface EcoCashPaymentResult {
  success: boolean;
  data?: {
    transactionId: string;
    resultCode: string;
    resultDesc: string;
    settledCurrency?: EcoCashCurrency;
    exchangeRate?: number;
    receipt?: string;
  };
  error?: string;
  providerErrorCode?: string;
  retryable?: boolean;
}

export interface EcoCashClientConfig {
  privateKey?: string;
  merchantCode?: string;
  merchantPin?: string;
  baseUrl?: string;
  depositPath?: string;
  disbursePath?: string;
  statusPath?: string;
  timeoutMs?: number;
  tokenManager?: EcoCashTokenManager;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  currencyEndpoints?: {
    USD?: { deposit?: string; disburse?: string };
    ZIG?: { deposit?: string; disburse?: string };
  };
}

export interface EcoCashReceiptParams {
  transactionId: string;
  reference: string;
  phoneNumber: string;
  amount: number;
  currency: EcoCashCurrency;
  settledCurrency: EcoCashCurrency;
  exchangeRate: number;
  status: string;
  timestamp?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Default exchange rates (ZIG to USD or USD base) */
const DEFAULT_EXCHANGE_RATES: Record<EcoCashCurrency, number> = {
  USD: 1.0,
  ZIG: 13.5,
};

/**
 * Builds the canonical pipe-delimited payload string for EcoCash RSA signing.
 */
export function buildSigningPayload(fields: {
  merchantCode: string;
  reference: string;
  msisdn: string;
  amount: string;
  wallet: string;
  timestamp: string;
}): string {
  return [
    fields.merchantCode,
    fields.reference,
    fields.msisdn,
    fields.amount,
    fields.wallet,
    fields.timestamp,
  ].join("|");
}

/** Signs a payload string with the merchant's RSA private key (SHA256). */
export function signPayload(payload: string, privateKey: string): string {
  if (!privateKey) {
    throw new Error("EcoCash Adapter: private key is missing");
  }
  const sign = crypto.createSign("SHA256");
  sign.update(payload);
  return sign.sign(privateKey.trim(), "base64");
}

function normalizeSubscriber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "");
  return digits.startsWith("263") ? digits : `263${digits}`;
}

/**
 * Format a readable receipt string that accurately records settled currency
 * and exchange rate.
 */
export function formatEcoCashReceipt(params: EcoCashReceiptParams): string {
  const dateStr = params.timestamp || new Date().toISOString();
  return [
    "========================================",
    "        ECOCASH TRANSACTION RECEIPT",
    "========================================",
    `Transaction ID: ${params.transactionId}`,
    `Reference: ${params.reference}`,
    `Date: ${dateStr}`,
    `Phone Number: ${params.phoneNumber}`,
    `Amount: ${params.amount} ${params.currency}`,
    `Settled Currency: ${params.settledCurrency}`,
    `Exchange Rate: ${params.exchangeRate}`,
    `Status: ${params.status}`,
    "========================================",
  ].join("\n");
}

export class EcoCashClient implements MobileMoneyProvider {
  private readonly privateKey: string;
  private readonly merchantCode: string;
  private readonly merchantPin: string;
  private readonly baseUrl: string;
  private readonly depositPath: string;
  private readonly disbursePath: string;
  private readonly statusPath: string;
  private readonly timeoutMs: number;
  private readonly tokenManager?: EcoCashTokenManager;
  private readonly currencyEndpoints?: EcoCashClientConfig["currencyEndpoints"];

  constructor(config: EcoCashClientConfig = {}) {
    this.privateKey =
      config.privateKey ?? process.env.ECOCASH_PRIVATE_KEY ?? "";
    this.merchantCode =
      config.merchantCode ?? process.env.ECOCASH_MERCHANT_CODE ?? "";
    this.merchantPin =
      config.merchantPin ?? process.env.ECOCASH_MERCHANT_PIN ?? "";
    this.baseUrl =
      config.baseUrl ??
      process.env.ECOCASH_BASE_URL ??
      "https://api.ecocash.co.zw/merchant";
    this.depositPath =
      config.depositPath ??
      process.env.ECOCASH_DEPOSIT_PATH ??
      "/v1/payments";
    this.disbursePath =
      config.disbursePath ??
      process.env.ECOCASH_DISBURSE_PATH ??
      "/v1/disburse";
    this.statusPath =
      config.statusPath ?? process.env.ECOCASH_STATUS_PATH ?? "/v1/status";
    this.timeoutMs =
      config.timeoutMs ??
      (Number(process.env.ECOCASH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    this.currencyEndpoints = config.currencyEndpoints;

    const oauthConfigured = Boolean(
      config.tokenManager ??
      config.tokenUrl ??
      config.clientId ??
      config.clientSecret ??
      process.env.ECOCASH_TOKEN_URL ??
      process.env.ECOCASH_CLIENT_ID ??
      process.env.ECOCASH_CLIENT_SECRET,
    );
    this.tokenManager =
      config.tokenManager ??
      (oauthConfigured
        ? createEcoCashAuth({
            tokenUrl: config.tokenUrl,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            timeoutMs: this.timeoutMs,
          })
        : undefined);
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (!this.tokenManager) return {};
    return this.tokenManager.getAuthorizationHeader();
  }

  private joinUrl(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  /**
   * Resolves the currency-specific endpoint URL for deposits.
   */
  getDepositEndpoint(currency: EcoCashCurrency): string {
    const override = this.currencyEndpoints?.[currency]?.deposit;
    if (override) return this.joinUrl(override);

    const suffix = currency.toLowerCase();
    return this.joinUrl(`${this.depositPath}/${suffix}`);
  }

  /**
   * Resolves the currency-specific endpoint URL for disbursements.
   */
  getDisburseEndpoint(currency: EcoCashCurrency): string {
    const override = this.currencyEndpoints?.[currency]?.disburse;
    if (override) return this.joinUrl(override);

    const suffix = currency.toLowerCase();
    return this.joinUrl(`${this.disbursePath}/${suffix}`);
  }

  /**
   * EcoCash collection (deposit / requestPayment):
   * Initiates payment prompt on customer handset for USD or ZIG.
   */
  async requestPayment(
    phoneNumber: string,
    amount: string | number,
    currencyInput: string = "USD",
    options?: {
      requestId?: string;
      exchangeRate?: number;
    },
  ): Promise<EcoCashPaymentResult> {
    let validatedCurrency: EcoCashCurrency;
    try {
      validatedCurrency = normalizeEcoCashCurrency(currencyInput);
      validateEcoCashPayment({
        phoneNumber,
        amount,
        currency: validatedCurrency,
      });
    } catch (err: any) {
      const errorMsg = err?.errors?.[0]?.message || err.message;
      return { success: false, error: errorMsg, retryable: false };
    }

    const reference = options?.requestId || `ecocash-deposit-${Date.now()}`;
    const log = logger.child({ requestId: reference });
    log.info(
      maskPII({ phoneNumber, amount, currency: validatedCurrency }),
      "EcoCash: Submitting payment collection request",
    );

    if (!this.merchantCode || !this.merchantPin) {
      const errorMsg = "EcoCash Adapter: merchant credentials are not configured";
      log.error(errorMsg);
      return { success: false, error: errorMsg, retryable: false };
    }

    const numericAmount = Number(amount);
    const msisdn = normalizeSubscriber(phoneNumber);
    const timestamp = new Date().toISOString();
    const exchangeRate =
      options?.exchangeRate ?? DEFAULT_EXCHANGE_RATES[validatedCurrency];

    const signature = signPayload(
      buildSigningPayload({
        merchantCode: this.merchantCode,
        reference,
        msisdn,
        amount: String(numericAmount),
        wallet: validatedCurrency,
        timestamp,
      }),
      this.privateKey,
    );

    const endpointUrl = this.getDepositEndpoint(validatedCurrency);

    try {
      const authHeaders = await this.authHeaders();
      const response = await http.post(
        endpointUrl,
        {
          merchantCode: this.merchantCode,
          merchantPin: this.merchantPin,
          reference,
          msisdn,
          amount: numericAmount,
          currency: validatedCurrency,
          settledCurrency: validatedCurrency,
          exchangeRate,
          timestamp,
          signature,
        },
        {
          headers: { "Content-Type": "application/json", ...authHeaders },
          timeout: this.timeoutMs,
        },
      );

      const body = response.data as {
        transactionId?: string;
        resultCode?: string;
        resultDesc?: string;
      };

      const transactionId = body.transactionId ?? reference;
      const receipt = formatEcoCashReceipt({
        transactionId,
        reference,
        phoneNumber: msisdn,
        amount: numericAmount,
        currency: validatedCurrency,
        settledCurrency: validatedCurrency,
        exchangeRate,
        status: body.resultCode === "0" ? "SUCCESS" : body.resultCode ?? "PENDING",
        timestamp,
      });

      return {
        success: true,
        data: {
          transactionId,
          resultCode: body.resultCode ?? "0",
          resultDesc: body.resultDesc ?? "Payment initiated",
          settledCurrency: validatedCurrency,
          exchangeRate,
          receipt,
        },
      };
    } catch (error: unknown) {
      const statusCode =
        error instanceof AxiosError ? error.response?.status : undefined;
      const responseBody =
        error instanceof AxiosError
          ? (error.response?.data as Record<string, unknown> | undefined)
          : undefined;
      const resultCode = responseBody?.resultCode as string | undefined;

      if (statusCode === 401 && this.tokenManager) {
        await this.tokenManager.invalidate();
      }

      const mapped = resolveEcoCashErrorFromResponse(resultCode, statusCode);
      return {
        success: false,
        error: mapped?.message ?? "EcoCash payment request failed",
        providerErrorCode: resultCode,
        retryable: mapped?.retryable ?? false,
      };
    }
  }

  /**
   * EcoCash disbursement (payout/cash-out):
   * Sends funds to customer EcoCash wallet in USD or ZIG.
   */
  async disburse(
    phoneNumber: string,
    amount: string | number,
    currencyInput: string = "USD",
    requestId?: string,
    options?: {
      exchangeRate?: number;
    },
  ): Promise<EcoCashDisbursementResult> {
    let validatedCurrency: EcoCashCurrency;
    try {
      validatedCurrency = normalizeEcoCashCurrency(currencyInput);
      validateEcoCashDisbursement({
        phoneNumber,
        amount,
        currency: validatedCurrency,
      });
    } catch (err: any) {
      const errorMsg = err?.errors?.[0]?.message || err.message;
      return { success: false, error: errorMsg, retryable: false };
    }

    const reference = requestId || `ecocash-disburse-${Date.now()}`;
    const log = logger.child({ requestId: reference });
    log.info(
      maskPII({ phoneNumber, amount, currency: validatedCurrency }),
      "EcoCash: Submitting disbursement",
    );

    if (!this.merchantCode || !this.merchantPin) {
      const errorMsg = "EcoCash Adapter: merchant credentials are not configured";
      log.error(errorMsg);
      return { success: false, error: errorMsg, retryable: false };
    }

    const numericAmount = Number(amount);
    const msisdn = normalizeSubscriber(phoneNumber);
    const timestamp = new Date().toISOString();
    const exchangeRate =
      options?.exchangeRate ?? DEFAULT_EXCHANGE_RATES[validatedCurrency];

    const signature = signPayload(
      buildSigningPayload({
        merchantCode: this.merchantCode,
        reference,
        msisdn,
        amount: String(numericAmount),
        wallet: validatedCurrency,
        timestamp,
      }),
      this.privateKey,
    );

    const endpointUrl = this.getDisburseEndpoint(validatedCurrency);

    try {
      const authHeaders = await this.authHeaders();
      const response = await http.post(
        endpointUrl,
        {
          merchantCode: this.merchantCode,
          merchantPin: this.merchantPin,
          reference,
          msisdn,
          amount: numericAmount,
          currency: validatedCurrency,
          settledCurrency: validatedCurrency,
          exchangeRate,
          wallet: validatedCurrency,
          timestamp,
          signature,
        },
        {
          headers: { "Content-Type": "application/json", ...authHeaders },
          timeout: this.timeoutMs,
        },
      );

      const body = response.data as {
        transactionId?: string;
        resultCode?: string;
        resultDesc?: string;
      };

      const transactionId = body.transactionId ?? reference;

      try {
        await scheduleEcoCashStatusPoll(transactionId);
      } catch (schedulingError) {
        log.error(
          { schedulingError },
          "EcoCash: Failed to schedule status-poll fallback",
        );
      }

      const receipt = formatEcoCashReceipt({
        transactionId,
        reference,
        phoneNumber: msisdn,
        amount: numericAmount,
        currency: validatedCurrency,
        settledCurrency: validatedCurrency,
        exchangeRate,
        status: body.resultCode === "0" ? "SUCCESS" : body.resultCode ?? "PENDING",
        timestamp,
      });

      return {
        success: true,
        data: {
          transactionId,
          resultCode: body.resultCode ?? "PENDING",
          resultDesc: body.resultDesc ?? "Disbursement accepted",
          settledCurrency: validatedCurrency,
          exchangeRate,
          receipt,
        },
      };
    } catch (error: unknown) {
      const statusCode =
        error instanceof AxiosError ? error.response?.status : undefined;
      const responseBody =
        error instanceof AxiosError
          ? (error.response?.data as Record<string, unknown> | undefined)
          : undefined;
      const resultCode = responseBody?.resultCode as string | undefined;

      if (statusCode === 401 && this.tokenManager) {
        await this.tokenManager.invalidate();
      }

      const mapped = resolveEcoCashErrorFromResponse(resultCode, statusCode);
      return {
        success: false,
        error: mapped?.message ?? "EcoCash disbursement request failed",
        providerErrorCode: resultCode,
        retryable: mapped?.retryable ?? false,
      };
    }
  }

  async sendPayout(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    const result = await this.disburse(phoneNumber, amount, "USD", requestId);
    return {
      success: result.success,
      data: result.data,
      error: result.error,
    };
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: ProviderTransactionStatus }> {
    const log = logger;
    log.info(maskPII({ referenceId }), "EcoCash: Querying transaction status");

    try {
      const authHeaders = await this.authHeaders();
      const response = await retryWithJitter(() =>
        http.get(this.joinUrl(this.statusPath), {
          params: { merchantCode: this.merchantCode, reference: referenceId },
          headers: { "Content-Type": "application/json", ...authHeaders },
          timeout: this.timeoutMs,
        }),
      );

      const status = (
        response.data?.status as string | undefined
      )?.toUpperCase();
      if (status === "SUCCESS" || status === "COMPLETED") {
        return { status: "completed" };
      }
      if (status === "FAILED") {
        return { status: "failed" };
      }
      if (status === "PENDING") {
        return { status: "pending" };
      }
      return { status: "unknown" };
    } catch (error: unknown) {
      if (
        error instanceof AxiosError &&
        error.response?.status === 401 &&
        this.tokenManager
      ) {
        await this.tokenManager.invalidate();
      }
      log.error(
        {
          referenceId,
          error: error instanceof Error ? error.message : String(error),
        },
        "EcoCash: Status query failed",
      );
      return { status: "unknown" };
    }
  }
}
