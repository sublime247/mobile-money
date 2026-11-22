/**
 * TypeScript SDK Client with strongly-typed error handling and response interceptor
 */

export * from "./errors/index.ts";
export * from "../ts/types.ts";
export { StellarBridgeClient } from "../ts/client.ts";
export { FetchTransport, type Transport } from "../ts/transport.ts";

import { parseApiError } from "./errors/index.ts";

export interface ApiResponseLike {
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}

/**
 * API response interceptor for client HTTP requests (Axios/Fetch compatible)
 * Parses HTTP response error payloads and instantiates corresponding typed error class
 */
export function apiResponseInterceptor(response: ApiResponseLike): ApiResponseLike {
  if (response.status >= 400) {
    throw parseApiError(response.status, response.data, response.headers);
  }
  return response;
}

