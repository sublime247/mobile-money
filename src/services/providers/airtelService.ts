import axios, { AxiosError } from "axios";
import { BaseProvider, ProviderAuthConfig } from "./baseProvider";
import { recordTelecomLatency } from "../../utils/logger";
import logger from "../../utils/logger";
import CircuitBreaker from "opossum";
import fs from "fs";
import path from "path";
import { sendAlert } from "../alertService";

interface AirtelTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

interface AirtelStatusResponse {
  data?: {
    transaction?: {
      status?: string;
      id?: string;
    };
    status?: string;
  };
  status?: {
    success?: boolean;
    code?: string;
    result_code?: string;
  };
  transaction_status?: string;
}

export type AirtelTransactionStatus =
  | "completed"
  | "failed"
  | "pending"
  | "unknown";

export interface AirtelServiceConfig extends Partial<ProviderAuthConfig> {
  country?: string;
  currency?: string;
}

interface AirtelResolvedConfig extends ProviderAuthConfig {
  country: string;
  currency: string;
}

const POLL_DELAY_MS = 15_000;
const MAX_POLL_ATTEMPTS = 4;

let pollTimeoutId: ReturnType<typeof setTimeout> | null = null;
const pollEntries: Map<string, { reference: string; service: AirtelService; attempt: number }> = new Map();

function startPollProcessor(): void {
  if (pollTimeoutId !== null) return;
  if (pollEntries.size === 0) return;
  pollTimeoutId = setTimeout(async () => {
    pollTimeoutId = null;
    const batch = [...pollEntries.entries()];
    pollEntries.clear();
    for (const [, entry] of batch) {
      try {
        const result = await entry.service.getTransactionStatus(entry.reference);
        if (result.status === "pending" && entry.attempt < MAX_POLL_ATTEMPTS) {
          addPollEntry(entry.reference, entry.service, entry.attempt + 1);
        } else {
          logger.info(
            { reference: entry.reference, status: result.status, attempts: entry.attempt },
            "Airtel poll resolved transaction status",
          );
        }
      } catch (err) {
        logger.error(
          { reference: entry.reference, error: err instanceof Error ? err.message : err },
          "Airtel poll attempt failed, will retry",
        );
        if (entry.attempt < MAX_POLL_ATTEMPTS) {
          addPollEntry(entry.reference, entry.service, entry.attempt + 1);
        }
      }
    }
    startPollProcessor();
  }, POLL_DELAY_MS);
}

function addPollEntry(reference: string, service: AirtelService, attempt = 1): void {
  const key = `${reference}-${attempt}`;
  if (!pollEntries.has(key)) {
    pollEntries.set(key, { reference, service, attempt });
    startPollProcessor();
  }
}

function isNetworkTimeout(error: unknown): boolean {
  if (error instanceof AxiosError) {
    return (
      error.code === "ECONNABORTED" ||
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNRESET" ||
      error.code === "ENOTFOUND" ||
      error.message?.toLowerCase().includes("timeout") ||
      error.message?.toLowerCase().includes("econnabort")
    );
  }
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /timeout|econnabort|etimedout|econnreset|enotfound/i.test(msg);
}

function buildAirtelConfig(opts: AirtelServiceConfig = {}): AirtelResolvedConfig {
  return {
    apiKey: opts.apiKey ?? process.env.AIRTEL_API_KEY ?? "",
    apiSecret: opts.apiSecret ?? process.env.AIRTEL_API_SECRET ?? "",
    baseUrl: opts.baseUrl ?? process.env.AIRTEL_BASE_URL ?? "https://openapi.airtel.africa",
    timeoutMs: opts.timeoutMs ?? 10_000,
    country: opts.country ?? process.env.AIRTEL_COUNTRY ?? "NG",
    currency: opts.currency ?? process.env.AIRTEL_CURRENCY ?? "NGN",
  };
}

function logAuditStatusChange(state: string, details: any): void {
  try {
    const auditLogPath = path.resolve(process.cwd(), "logs", "audit.log");
    const logDir = path.dirname(auditLogPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "airtel",
      circuitBreakerState: state,
      details,
    }) + "\n";
    fs.appendFileSync(auditLogPath, entry);
  } catch (err) {
    logger.error({ error: err }, "Failed to write circuit breaker audit log");
  }
  logger.info({ state, details }, `Airtel circuit breaker status changed to ${state}`);
}

export class AirtelService extends BaseProvider {
  private readonly country: string;
  private readonly currency: string;
  private readonly providerName: string = "airtel";
  private breaker: CircuitBreaker;

  constructor(opts: AirtelServiceConfig = {}) {
    const config = buildAirtelConfig(opts);
    super(config);
    this.country = config.country;
    this.currency = config.currency;

    const breakerOptions = {
      timeout: this.timeoutMs,
      errorThresholdPercentage: 50,
      volumeThreshold: 10,
      resetTimeout: 30_000,
    };

    this.breaker = new CircuitBreaker(async (fn: () => Promise<any>) => fn(), breakerOptions);

    this.breaker.on("open", () => {
      logAuditStatusChange("open", { volumeThreshold: 10, errorThresholdPercentage: 50 });
      void sendAlert({
        provider: "airtel",
        error: "Circuit breaker OPEN: error rate exceeded 50% threshold over the last 10 requests",
        severity: "critical",
      }).catch((err) =>
        logger.error({ error: err }, "Failed to dispatch circuit breaker open alert"),
      );
    });
    this.breaker.on("halfOpen", () => logAuditStatusChange("half_open", {}));
    this.breaker.on("close", () => logAuditStatusChange("closed", {}));
    this.breaker.fallback(() => {
      logger.warn("Airtel circuit breaker is OPEN. Routing transaction to fallback queue.");
      return { success: false, fallbackRouted: true, error: "Circuit breaker is open. Routed to fallback queue." };
    });
  }

  public async executeWithBreaker<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker.fire(fn) as Promise<T>;
  }

  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }

    const startTime = Date.now();
    const endpoint = "/auth/oauth2/token";
    try {
      const response = await this.executeWithBreaker(async () =>
        axios.post<AirtelTokenResponse>(
          `${this.baseUrl}${endpoint}`,
          undefined,
          {
            headers: {
              Authorization: this.buildBasicAuthHeader(this.apiKey, this.apiSecret),
              "Content-Type": "application/json",
            },
            timeout: this.timeoutMs,
          },
        )
      );

      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        country: this.country,
        operation: "getAccessToken",
        durationMs,
        success: true,
      });

      const data = response.data;
      const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
      this.cacheToken(data.access_token, expiresIn);
      return data.access_token;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        country: this.country,
        operation: "getAccessToken",
        durationMs,
        success: false,
      });
      logger.error(
        { error: error instanceof Error ? error.message : error, durationMs },
        "Airtel getAccessToken failed",
      );
      throw error;
    }
  }

  async initiatePayment(phoneNumber: string, amount: string, reference: string): Promise<any> {
    const startTime = Date.now();
    const endpoint = "/standard/v1/payments/";
    try {
      const token = await this.getAccessToken();
      const payload = {
        reference,
        subscriber: {
          country: this.country,
          currency: this.currency,
          msisdn: phoneNumber,
        },
        transaction: {
          amount,
          country: this.country,
          currency: this.currency,
          id: reference,
        },
      };

      const response = await this.executeWithBreaker(async () =>
        axios.post(
          `${this.baseUrl}${endpoint}`,
          payload,
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "X-Country": this.country,
              "X-Currency": this.currency,
              "Content-Type": "application/json",
            },
            timeout: this.timeoutMs,
          },
        )
      );

      if ((response as any).fallbackRouted) {
        return response;
      }

      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        country: this.country,
        operation: "initiatePayment",
        durationMs,
        success: true,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      if (isNetworkTimeout(error)) {
        logger.error({ error, reference }, "Airtel payment request timed out");
      }
      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        country: this.country,
        operation: "initiatePayment",
        durationMs,
        success: false,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : error,
      };
    }
  }

  async getTransactionStatus(reference: string): Promise<{ status: AirtelTransactionStatus }> {
    const endpoint = `/standard/v1/payments/${reference}`;
    try {
      const token = await this.getAccessToken();
      const response = await this.executeWithBreaker(async () =>
        axios.get<AirtelStatusResponse>(
          `${this.baseUrl}${endpoint}`,
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "X-Country": this.country,
              "X-Currency": this.currency,
              "Content-Type": "application/json",
            },
            timeout: this.timeoutMs,
          },
        )
      );

      if ((response as any).fallbackRouted) {
        return { status: "pending" };
      }

      const statusStr = response.data?.data?.transaction?.status?.toLowerCase() ??
        response.data?.status?.success ? "completed" : "unknown";

      if (statusStr.includes("success") || statusStr.includes("complet")) {
        return { status: "completed" };
      }
      if (statusStr.includes("fail") || statusStr.includes("error")) {
        return { status: "failed" };
      }
      if (statusStr.includes("pending") || statusStr.includes("process")) {
        return { status: "pending" };
      }
      return { status: "unknown" };
    } catch (error) {
      logger.error({ reference, error: error instanceof Error ? error.message : error }, "Airtel getTransactionStatus failed");
      return { status: "unknown" };
    }
  }

  async getBalance(): Promise<{ success: boolean; data?: any; error?: string }> {
    const endpoint = `/standard/v1/users/balance`;
    try {
      const token = await this.getAccessToken();
      const response = await this.executeWithBreaker(async () =>
        axios.get(
          `${this.baseUrl}${endpoint}`,
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "X-Country": this.country,
              "X-Currency": this.currency,
              "Content-Type": "application/json",
            },
            timeout: this.timeoutMs,
          }
        )
      );

      if ((response as any).fallbackRouted) {
        return { success: false, error: "Circuit breaker open" };
      }

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, "Airtel getBalance failed");
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
