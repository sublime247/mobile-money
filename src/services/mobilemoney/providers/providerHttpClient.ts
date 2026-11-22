/**
 * Shared HTTP client factory for mobile money provider integrations.
 *
 * Every provider builds its own Axios instance (`axios.create()` instances do
 * not inherit interceptors from the default export), so cross-cutting
 * behaviour is attached here once and reused:
 *
 *  - X-Correlation-ID propagation (src/utils/correlationIdInterceptor.ts);
 *  - failed-call capture (#2445): when a provider request fails, the request
 *    headers/body, status code and response headers/body are sanitized
 *    (src/utils/payloadSanitizer.ts), capped at 32KB each, and written to
 *    `provider_error_logs`. The original error is always re-thrown unchanged.
 */
import axios, {
  type AxiosError,
  type AxiosInstance,
  type CreateAxiosDefaults,
  type InternalAxiosRequestConfig,
} from "axios";
import { attachCorrelationIdInterceptor } from "../../../utils/correlationIdInterceptor";
import {
  sanitizeAndLimit,
  sanitizePayload,
  sanitizeUrl,
} from "../../../utils/payloadSanitizer";
import {
  recordProviderErrorLog,
  type ProviderErrorSnapshot,
} from "../../providerErrorLogService";
import { getCurrentCorrelationId } from "../../../middleware/correlationId";

type ErrorRecorder = (snapshot: ProviderErrorSnapshot) => Promise<void>;

export interface ProviderErrorInterceptorOptions {
  /** Persists a snapshot; defaults to {@link recordProviderErrorLog}. */
  recorder?: ErrorRecorder;
  /**
   * Which failures to capture. Defaults to every failure: transport errors
   * (no response) and any non-2xx response the client rejected.
   */
  shouldCapture?: (error: AxiosError) => boolean;
}

const START_TIME = Symbol("providerRequestStartedAt");

type TimedConfig = InternalAxiosRequestConfig & { [START_TIME]?: number };

function parseBody(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function buildUrl(config: InternalAxiosRequestConfig | undefined): string | undefined {
  if (!config) return undefined;
  const base = config.baseURL ?? "";
  const path = config.url ?? "";
  const full = /^https?:\/\//i.test(path)
    ? path
    : `${base.replace(/\/+$/, "")}${path && !path.startsWith("/") ? "/" : ""}${path}`;
  return sanitizeUrl(full || undefined);
}

/** Build the sanitized, size-capped snapshot for a failed provider call. */
export function buildProviderErrorSnapshot(
  provider: string,
  error: AxiosError,
): ProviderErrorSnapshot {
  const config = error.config as TimedConfig | undefined;
  const response = error.response;

  const requestBody = sanitizeAndLimit(parseBody(config?.data));
  const responseBody = sanitizeAndLimit(parseBody(response?.data));
  const startedAt = config?.[START_TIME];

  return {
    provider,
    method: config?.method?.toUpperCase(),
    url: buildUrl(config),
    statusCode: response?.status,
    errorCode: error.code,
    errorMessage: error.message,
    requestHeaders: config?.headers ? sanitizePayload(config.headers) : undefined,
    requestBody: requestBody.payload ?? undefined,
    responseHeaders: response?.headers
      ? sanitizePayload(response.headers)
      : undefined,
    responseBody: responseBody.payload ?? undefined,
    payloadTruncated: requestBody.truncated || responseBody.truncated,
    durationMs:
      typeof startedAt === "number" ? Date.now() - startedAt : undefined,
    correlationId: getCurrentCorrelationId(),
  };
}

/**
 * Attach the failed-call capture interceptor to a provider's Axios instance.
 * Recording is fire-and-forget so the caller's error path is never delayed.
 */
export function attachProviderErrorInterceptor(
  client: AxiosInstance,
  provider: string,
  options: ProviderErrorInterceptorOptions = {},
): void {
  // Some tests stub axios.create() with a bare { get, post } object.
  if (!client?.interceptors?.response || !client.interceptors.request) return;

  const recorder = options.recorder ?? recordProviderErrorLog;
  const shouldCapture = options.shouldCapture ?? (() => true);

  client.interceptors.request.use((config: TimedConfig) => {
    config[START_TIME] = Date.now();
    return config;
  });

  client.interceptors.response.use(undefined, (error: unknown) => {
    if (axios.isAxiosError(error) && shouldCapture(error)) {
      try {
        const snapshot = buildProviderErrorSnapshot(provider, error);
        void recorder(snapshot).catch(() => undefined);
      } catch {
        // Never let snapshot building mask the real provider error.
      }
    }
    return Promise.reject(error);
  });
}

/**
 * `axios.create()` plus the standard provider interceptors. Use this instead
 * of calling `axios.create()` directly in provider classes.
 */
export function createProviderHttpClient(
  provider: string,
  config: CreateAxiosDefaults = {},
  options: ProviderErrorInterceptorOptions = {},
): AxiosInstance {
  const client = axios.create(config);
  attachCorrelationIdInterceptor(client);
  attachProviderErrorInterceptor(client, provider, options);
  return client;
}
