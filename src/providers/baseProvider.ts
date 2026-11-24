/**
 * Circuit-breaker protection for telco gateway HTTP adapters (#2571).
 *
 * Every outbound call to a mobile money gateway (MTN, Orange, M-Pesa, Wave,
 * ...) goes through a per-provider {@link RollingCircuitBreaker}:
 *
 *  - CLOSED: requests flow; outcomes are recorded in a 30s rolling window and
 *    the circuit trips to OPEN once the error rate exceeds 50%.
 *  - OPEN: requests fail fast with a 503 {@link CircuitOpenError} before any
 *    socket is opened, so a dead endpoint is not hammered.
 *  - HALF_OPEN (after a 60s cooldown): a single trial request is let through;
 *    success closes the circuit, failure re-opens it.
 *
 * Only transport errors (timeouts, resets, DNS) and 5xx / 429 responses count
 * as provider failures. A 4xx is the caller's fault and does not trip the
 * circuit.
 *
 * Two integration styles are offered:
 *  - {@link attachCircuitBreakerInterceptor} wires the breaker into an Axios
 *    instance (used by `createProviderHttpClient`, so every adapter built on
 *    the shared factory is covered without code changes);
 *  - {@link BaseProvider} for adapters that issue requests themselves.
 */
import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import {
  CircuitOpenError,
  CircuitState,
  getProviderCircuitBreaker,
  type RollingCircuitBreaker,
} from "../utils/circuitBreaker";

export { CircuitOpenError, CircuitState };

/** True when `error` means the provider itself is unhealthy. */
export function isProviderFailure(error: unknown): boolean {
  if (error instanceof CircuitOpenError) return false;
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === undefined) return true; // network / timeout
    return status >= 500 || status === 429;
  }
  const status = (error as { status?: number; statusCode?: number } | null)
    ?.status ?? (error as { statusCode?: number } | null)?.statusCode;
  if (typeof status === "number") return status >= 500 || status === 429;
  return true;
}

const BREAKER_PERMIT = Symbol("circuitBreakerPermit");
type PermittedConfig = InternalAxiosRequestConfig & {
  [BREAKER_PERMIT]?: RollingCircuitBreaker;
};

/**
 * Gate an Axios instance with the provider's circuit breaker. Idempotent per
 * instance. Requests rejected by an OPEN circuit never reach the adapter.
 */
export function attachCircuitBreakerInterceptor(
  client: AxiosInstance,
  provider: string,
  breaker: RollingCircuitBreaker = getProviderCircuitBreaker(provider),
): AxiosInstance {
  // Some tests stub axios.create() with a bare { get, post } object.
  if (!client?.interceptors?.request || !client.interceptors.response) {
    return client;
  }
  const marked = client as AxiosInstance & { [BREAKER_PERMIT]?: true };
  if (marked[BREAKER_PERMIT]) return client;
  marked[BREAKER_PERMIT] = true;

  client.interceptors.request.use((config: PermittedConfig) => {
    breaker.acquire(); // throws CircuitOpenError (503) when OPEN
    config[BREAKER_PERMIT] = breaker;
    return config;
  });

  client.interceptors.response.use(
    (response: AxiosResponse) => {
      const permit = (response.config as PermittedConfig)?.[BREAKER_PERMIT];
      permit?.recordSuccess();
      return response;
    },
    (error: unknown) => {
      // Fast-failed requests were never permitted, so nothing to record.
      const config = axios.isAxiosError(error)
        ? (error.config as PermittedConfig | undefined)
        : undefined;
      const permit = config?.[BREAKER_PERMIT];
      if (permit) {
        if (isProviderFailure(error)) permit.recordFailure();
        else permit.recordSuccess();
      }
      return Promise.reject(error);
    },
  );
  return client;
}

/**
 * Base class for telco adapters that make their own HTTP calls. Subclasses
 * call {@link request} (or wrap arbitrary async work in {@link guarded}) and
 * inherit fast-fail and recovery behaviour.
 */
export abstract class BaseProvider {
  protected readonly breaker: RollingCircuitBreaker;

  protected constructor(
    readonly providerName: string,
    protected readonly http: AxiosInstance = axios.create(),
    breaker?: RollingCircuitBreaker,
  ) {
    this.breaker = breaker ?? getProviderCircuitBreaker(providerName);
  }

  get circuitState(): CircuitState {
    return this.breaker.getState();
  }

  /** Run any provider call through the circuit breaker. */
  protected guarded<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker.execute(fn, isProviderFailure);
  }

  /** Issue an HTTP request to the gateway through the circuit breaker. */
  protected request<T = unknown>(
    config: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.guarded(() => this.http.request<T>(config));
  }
}
