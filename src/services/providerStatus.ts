import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import { redisClient } from "../config/redis";
import logger from "../utils/logger";
import { sendProviderAuthFailureAlert } from "./alertService";

const AUTH_FAILURE_THRESHOLD = 3;
const CLEAR_AUTH_FAILURES = "return redis.call('DEL', KEYS[1])";

export async function recordProviderAuthStatus(
  provider: string,
  status: number | undefined,
): Promise<void> {
  if (!status || !redisClient?.isReady) return;

  const key = `provider:auth-failures:${provider}`;
  try {
    if (status !== 401 && status !== 403) {
      await redisClient.eval(CLEAR_AUTH_FAILURES, { keys: [key] });
      return;
    }

    // INCR is atomic across workers, so only one response reaches the threshold.
    const count = await redisClient.incr(key);
    if (count === AUTH_FAILURE_THRESHOLD) {
      await sendProviderAuthFailureAlert(provider, count, status);
    }
  } catch {
    logger.warn("Could not track provider authentication response", {
      provider,
    });
  }
}

function onResponse(provider: string, response: AxiosResponse): void {
  void recordProviderAuthStatus(provider, response?.status);
}

function onError(provider: string, error: unknown): void {
  const status = (error as { response?: { status?: number } } | null)?.response
    ?.status;
  void recordProviderAuthStatus(provider, status);
}

export function monitorProviderClient<T extends AxiosInstance>(
  provider: string,
  client: T,
): T {
  client.interceptors?.response?.use(
    (response) => {
      onResponse(provider, response);
      return response;
    },
    (error: unknown) => {
      onError(provider, error);
      return Promise.reject(error);
    },
  );
  return client;
}

// Preserve the shared Axios defaults for providers that call get/post directly.
export function providerHttp(
  provider: string,
): Pick<typeof axios, "get" | "post" | "create"> {
  function observe<R>(request: Promise<R>): Promise<R> {
    return request.then(
      (response) => {
        onResponse(provider, response as AxiosResponse);
        return response;
      },
      (error: unknown) => {
        onError(provider, error);
        throw error;
      },
    );
  }

  return {
    get: <T = AxiosResponse["data"], R = AxiosResponse<T>, D = unknown>(
      url: string,
      config?: AxiosRequestConfig<D>,
    ) =>
      observe(
        config === undefined
          ? axios.get<T, R, D>(url)
          : axios.get<T, R, D>(url, config),
      ),
    post: <T = AxiosResponse["data"], R = AxiosResponse<T>, D = unknown>(
      url: string,
      data?: D,
      config?: AxiosRequestConfig<D>,
    ) =>
      observe(
        config === undefined
          ? axios.post<T, R, D>(url, data)
          : axios.post<T, R, D>(url, data, config),
      ),
    create: (config) => monitorProviderClient(provider, axios.create(config)),
  };
}
