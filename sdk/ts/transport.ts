/**
 * Transport adapter interface supporting both native Fetch and Axios
 */

import { BridgeError, AuthenticationError, ValidationError, NotFoundError } from "./errors.ts";

export interface HttpRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
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
  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
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
        this.handleErrorResponse(response.status, responseData);
      }

      return {
        status: response.status,
        data: responseData,
        headers: respHeaders,
      };
    } catch (err: any) {
      if (timer) clearTimeout(timer);
      if (err instanceof BridgeError) throw err;
      throw new BridgeError(err.message || "Network request failed", undefined, "NETWORK_ERROR", err);
    }
  }

  private handleErrorResponse(status: number, data: unknown): never {
    const message = (data as any)?.error || (data as any)?.message || `HTTP request failed with status ${status}`;
    if (status === 401) throw new AuthenticationError(message, data);
    if (status === 400) throw new ValidationError(message, data);
    if (status === 404) throw new NotFoundError(message, data);
    throw new BridgeError(message, status, "HTTP_ERROR", data);
  }
}
