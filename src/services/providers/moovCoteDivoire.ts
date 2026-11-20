import { AxiosError } from "axios";
import { providerHttp } from "../providerStatus";
import { randomUUID } from "crypto";
import { getConfigValue } from "../../config/appConfig";
import logger from "../../utils/logger";
import { maskPII } from "../../utils/masking";
import { BaseProvider, ProviderAuthConfig } from "./baseProvider";
import { resolveMoovErrorFromResponse } from "./errors/moovErrorMatrix";

const http = providerHttp("moov-ci");

const DEFAULT_AUTH_PATH = "/oauth/token";
const DEFAULT_DEPOSIT_PUSH_PATH = "/payments/deposit";
const DEFAULT_CURRENCY = "XOF";
const DEFAULT_TIMEOUT_MS = 10_000;

interface MoovTokenResponse {
  access_token?: string;
  expires_in?: number | string;
}

interface MoovCoteDivoireAppConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  authPath: string;
  depositPushPath: string;
  currency: string;
  timeoutMs: number;
}

export interface MoovCoteDivoireConfig extends Partial<ProviderAuthConfig> {
  authPath?: string;
  depositPushPath?: string;
  currency?: string;
}

interface ResolvedMoovCoteDivoireConfig extends ProviderAuthConfig {
  authPath: string;
  depositPushPath: string;
  currency: string;
}

export interface MoovDepositPushResult {
  success: boolean;
  referenceId: string;
  data?: unknown;
  error?: string;
}

function getAppConfig(): MoovCoteDivoireAppConfig {
  return getConfigValue(
    "providers.moovCoteDivoire",
  ) as MoovCoteDivoireAppConfig;
}

function buildConfig(
  options: MoovCoteDivoireConfig = {},
): ResolvedMoovCoteDivoireConfig {
  const appConfig = getAppConfig();

  return {
    apiKey: options.apiKey ?? appConfig.apiKey,
    apiSecret: options.apiSecret ?? appConfig.apiSecret,
    baseUrl: options.baseUrl ?? appConfig.baseUrl,
    timeoutMs: options.timeoutMs ?? appConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tokenExpiryLeewaySeconds: options.tokenExpiryLeewaySeconds ?? 30,
    authPath: options.authPath ?? appConfig.authPath ?? DEFAULT_AUTH_PATH,
    depositPushPath:
      options.depositPushPath ??
      appConfig.depositPushPath ??
      DEFAULT_DEPOSIT_PUSH_PATH,
    currency: options.currency ?? appConfig.currency ?? DEFAULT_CURRENCY,
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function normalizePhoneNumber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "");

  if (digits.startsWith("225")) {
    return digits;
  }
  return `225${digits}`;
}

export class MoovCoteDivoireProvider extends BaseProvider {
  private readonly authPath: string;
  private readonly depositPushPath: string;
  private readonly currency: string;

  constructor(options: MoovCoteDivoireConfig = {}) {
    const config = buildConfig(options);
    super(config);
    this.authPath = config.authPath;
    this.depositPushPath = config.depositPushPath;
    this.currency = config.currency;
  }

  public validatePhoneNumber(phoneNumber: string): boolean {
    return /^225\d{10}$/.test(normalizePhoneNumber(phoneNumber));
  }

  public async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }

    if (!this.apiKey || !this.apiSecret || !this.baseUrl) {
      throw new Error("Moov Côte d'Ivoire API configuration is incomplete");
    }

    const response = await http.post<MoovTokenResponse>(
      joinUrl(this.baseUrl, this.authPath),
      { grant_type: "client_credentials" },
      {
        headers: this.buildOAuth2TokenRequestHeaders(),
        timeout: this.timeoutMs,
      },
    );

    const accessToken = response.data?.access_token;
    const expiresIn = Number(response.data?.expires_in);

    if (
      !accessToken ||
      typeof accessToken !== "string" ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new Error(
        "Moov Côte d'Ivoire token response is missing required fields",
      );
    }

    this.cacheToken(accessToken, expiresIn);
    return accessToken;
  }

  public async triggerDepositPush(
    phoneNumber: string,
    amount: string | number,
    requestId: string = randomUUID(),
  ): Promise<MoovDepositPushResult> {
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
    const numericAmount = Number(amount);

    if (!/^225\d{10}$/.test(normalizedPhoneNumber)) {
      return {
        success: false,
        referenceId: requestId,
        error: "Invalid Côte d'Ivoire phone number",
      };
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return {
        success: false,
        referenceId: requestId,
        error: "Deposit amount must be greater than zero",
      };
    }

    const startedAt = Date.now();
    try {
      const accessToken = await this.getAccessToken();
      const response = await http.post(
        joinUrl(this.baseUrl, this.depositPushPath),
        {
          amount: numericAmount,
          currency: this.currency,
          phoneNumber: normalizedPhoneNumber,
          referenceId: requestId,
        },
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(accessToken),
            "Content-Type": "application/json",
          },
          timeout: this.timeoutMs,
        },
      );

      logger.info(
        maskPII({
          referenceId: requestId,
          phoneNumber: normalizedPhoneNumber,
          durationMs: Date.now() - startedAt,
        }),
        "Moov Côte d'Ivoire deposit push requested",
      );

      return {
        success: true,
        referenceId: requestId,
        data: response.data,
      };
    } catch (error: unknown) {
      const statusCode =
        error instanceof AxiosError ? error.response?.status : undefined;
      const responseBody =
        error instanceof AxiosError
          ? (error.response?.data as Record<string, unknown> | undefined)
          : undefined;
      const providerCode =
        (responseBody?.code as string | undefined) ??
        (responseBody?.error_code as string | undefined);

      const mapped = resolveMoovErrorFromResponse(providerCode, statusCode);

      logger.error(
        maskPII({
          referenceId: requestId,
          phoneNumber: normalizedPhoneNumber,
          durationMs: Date.now() - startedAt,
          statusCode,
          providerCode,
          mappedErrorCode: mapped?.errorCode,
        }),
        "Moov Côte d'Ivoire deposit push failed",
      );

      return {
        success: false,
        referenceId: requestId,
        error: mapped?.message ?? "Moov Côte d'Ivoire deposit push failed",
      };
    }
  }

  public async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<MoovDepositPushResult> {
    return this.triggerDepositPush(phoneNumber, amount, requestId);
  }
}
