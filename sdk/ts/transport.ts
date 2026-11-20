/**
 * Transport adapter interface supporting both native Fetch and Axios
 */

import {
  BridgeError,
  MobileMoneyError,
  AuthenticationError,
  InsufficientFundsError,
  TelcoTimeoutError,
  RateLimitError,
  ValidationError,
  NotFoundError,
  parseApiError,
} from "./errors.ts";
import type { RetryOptions } from "./types.ts";

export interface HttpRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

const IDEMPOTENT_METHODS = new Set(["GET", "PUT", "DELETE"]);
const RETRYABLE_STATUS_CODES = new Set([429, 503]);

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
};

/**
 * True when `options` is safe to retry automatically: GET/PUT/DELETE are
 * naturally idempotent, and POST is only retried when the caller supplies an
 * `Idempotency-Key` header, so the server can dedupe a request that actually
 * reached it before the response was lost.
 */
function isRetryableRequest(options: HttpRequestOptions): boolean {
  if (IDEMPOTENT_METHODS.has(options.method)) return true;
  if (options.method === "POST") {
    const headers = options.headers || {};
    return Object.keys(headers).some((h) => h.toLowerCase() === "idempotency-key");
  }
  return false;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof MobileMoneyError || err instanceof BridgeError) {
    if (err.providerErrorCode === "NETWORK_ERROR" || err.code === "NETWORK_ERROR") return true;
    const status = err.statusCode ?? err.status;
    if (status !== undefined && RETRYABLE_STATUS_CODES.has(status)) return true;
    return false;
  }
  return true;
}

/** Exponential backoff with full jitter, capped at `maxDelayMs`. */
function computeBackoffDelayMs(attempt: number, opts: Required<RetryOptions>): number {
  const exp = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
  return Math.random() * exp;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export interface Transport {
  request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>>;
}

/**
 * Native Fetch transport implementation
 */
export class FetchTransport implements Transport {
  private readonly retryOptions: Required<RetryOptions>;

  constructor(retryOptions?: RetryOptions) {
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  }

  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    if (!this.retryOptions.enabled || !isRetryableRequest(options)) {
      return this.performRequest<T>(options);
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
      try {
        return await this.performRequest<T>(options);
      } catch (err) {
        lastErr = err;
        const isLastAttempt = attempt === this.retryOptions.maxRetries;
        if (isLastAttempt || !isRetryableError(err)) {
          throw err;
        }
        await sleep(computeBackoffDelayMs(attempt, this.retryOptions));
      }
    }
    // Unreachable: the loop above always either returns or throws.
    throw lastErr;
  }

  private async performRequest<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    let fullUrl = options.url;
    if (options.params) {
      const urlObj = new URL(fullUrl);
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          urlObj.searchParams.set(key, String(value));
        }
      }
      fullUrl = urlObj.toString();
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };

    let bodyStr: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer: NodeJS.Timeout | null = null;
    if (controller && options.timeoutMs) {
      timer = setTimeout(() => controller.abort(), options.timeoutMs);
    }

    try {
      const response = await fetch(fullUrl, {
        method: options.method,
        headers,
        body: bodyStr,
        signal: controller ? controller.signal : undefined,
      });

      if (timer) clearTimeout(timer);

      const respHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        respHeaders[k.toLowerCase()] = v;
      });

      let responseData: T;
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        responseData = (await response.json()) as T;
      } else {
        responseData = (await response.text()) as unknown as T;
      }

      if (!response.ok) {
        this.handleErrorResponse(response.status, responseData, respHeaders);
      }

      return {
        status: response.status,
        data: responseData,
        headers: respHeaders,
      };
    } catch (err: any) {
      if (timer) clearTimeout(timer);
      if (err instanceof MobileMoneyError || err instanceof BridgeError) throw err;
      throw new BridgeError(err.message || "Network request failed", undefined, "NETWORK_ERROR", err);
    }
  }

  private handleErrorResponse(status: number, data: unknown, headers?: Record<string, string>): never {
    throw parseApiError(status, data, headers);
  }
}
