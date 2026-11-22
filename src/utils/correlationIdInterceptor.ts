import type { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import { getCurrentCorrelationId, CORRELATION_ID_HEADER } from "../middleware/correlationId";

/**
 * Registers a request interceptor that attaches the current request's
 * X-Correlation-ID (see `middleware/correlationId.ts`) to every outgoing
 * call made through this Axios instance.
 *
 * `axios.create()` instances do not inherit interceptors registered on the
 * default `axios` export, so this must be called on each provider's own
 * client instance rather than once globally.
 *
 * No-ops (adds no header) when called outside of a request context, e.g. a
 * background job or a script - there is no correlation ID to propagate.
 *
 * @example
 * this.client = axios.create({ baseURL: this.config.webBaseUrl });
 * attachCorrelationIdInterceptor(this.client);
 */
export function attachCorrelationIdInterceptor(client: AxiosInstance): void {
  // Defensive: some tests replace axios.create()'s return value with a bare
  // { get, post } stub via jest.mock("axios"), which has no .interceptors.
  // Skip attaching in that case rather than throwing from a constructor.
  if (!client?.interceptors?.request) return;

  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const correlationId = getCurrentCorrelationId();
    if (correlationId) {
      config.headers.set(CORRELATION_ID_HEADER, correlationId);
    }
    return config;
  });
}

/**
 * Fetch equivalent of {@link attachCorrelationIdInterceptor}, for provider
 * code that calls the global `fetch` instead of an Axios instance. Merges
 * the correlation ID header into whatever `RequestInit` the caller already
 * built, without mutating the object passed in.
 *
 * @example
 * const response = await fetch(url, withCorrelationId({ method: "POST", body }));
 */
export function withCorrelationId(init: RequestInit = {}): RequestInit {
  const correlationId = getCurrentCorrelationId();
  if (!correlationId) return init;

  const headers = new Headers(init.headers);
  headers.set(CORRELATION_ID_HEADER, correlationId);
  return { ...init, headers };
}
