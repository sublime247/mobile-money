/**
 * Custom error hierarchy for @stellar-bridge/sdk and Mobile Money SDK
 */

export interface MobileMoneyErrorOptions {
  statusCode?: number;
  providerErrorCode?: string;
  requestId?: string;
  details?: unknown;
}

export class MobileMoneyError extends Error {
  public readonly statusCode?: number;
  public readonly status?: number;
  public readonly providerErrorCode?: string;
  public readonly code?: string;
  public readonly requestId?: string;
  public readonly details?: unknown;

  constructor(
    message: string,
    optionsOrStatus?: number | MobileMoneyErrorOptions,
    providerErrorCode?: string,
    details?: unknown,
    requestId?: string
  ) {
    super(message);
    this.name = "MobileMoneyError";

    if (typeof optionsOrStatus === "object" && optionsOrStatus !== null) {
      this.statusCode = optionsOrStatus.statusCode;
      this.status = optionsOrStatus.statusCode;
      this.providerErrorCode = optionsOrStatus.providerErrorCode;
      this.code = optionsOrStatus.providerErrorCode;
      this.requestId = optionsOrStatus.requestId;
      this.details = optionsOrStatus.details;
    } else {
      this.statusCode = optionsOrStatus;
      this.status = optionsOrStatus;
      this.providerErrorCode = providerErrorCode;
      this.code = providerErrorCode;
      this.details = details;
      this.requestId = requestId;
    }

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BridgeError extends MobileMoneyError {
  constructor(
    message: string,
    status?: number,
    code?: string,
    details?: unknown,
    requestId?: string
  ) {
    super(message, {
      statusCode: status,
      providerErrorCode: code,
      details,
      requestId,
    });
    this.name = "BridgeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function resolveOptions(
  defaultStatus: number,
  defaultCode: string,
  optionsOrDetails?: MobileMoneyErrorOptions | unknown,
  providerErrorCode?: string,
  requestId?: string,
  statusCode?: number
): MobileMoneyErrorOptions {
  if (
    typeof optionsOrDetails === "object" &&
    optionsOrDetails !== null &&
    ("statusCode" in optionsOrDetails ||
      "providerErrorCode" in optionsOrDetails ||
      "requestId" in optionsOrDetails ||
      "details" in optionsOrDetails)
  ) {
    const opts = optionsOrDetails as MobileMoneyErrorOptions;
    return {
      statusCode: opts.statusCode ?? defaultStatus,
      providerErrorCode: opts.providerErrorCode ?? defaultCode,
      requestId: opts.requestId,
      details: opts.details,
    };
  }

  return {
    statusCode: statusCode ?? defaultStatus,
    providerErrorCode: providerErrorCode ?? defaultCode,
    requestId,
    details: optionsOrDetails,
  };
}

export class AuthenticationError extends MobileMoneyError {
  constructor(
    message: string,
    optionsOrDetails?: MobileMoneyErrorOptions | unknown,
    providerErrorCode?: string,
    requestId?: string,
    statusCode?: number
  ) {
    const opts = resolveOptions(401, "AUTHENTICATION_FAILED", optionsOrDetails, providerErrorCode, requestId, statusCode);
    super(message, opts);
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InsufficientFundsError extends MobileMoneyError {
  constructor(
    message: string,
    optionsOrDetails?: MobileMoneyErrorOptions | unknown,
    providerErrorCode?: string,
    requestId?: string,
    statusCode?: number
  ) {
    const opts = resolveOptions(400, "INSUFFICIENT_FUNDS", optionsOrDetails, providerErrorCode, requestId, statusCode);
    super(message, opts);
    this.name = "InsufficientFundsError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TelcoTimeoutError extends MobileMoneyError {
  constructor(
    message: string,
    optionsOrDetails?: MobileMoneyErrorOptions | unknown,
    providerErrorCode?: string,
    requestId?: string,
    statusCode?: number
  ) {
    const opts = resolveOptions(504, "TELCO_TIMEOUT", optionsOrDetails, providerErrorCode, requestId, statusCode);
    super(message, opts);
    this.name = "TelcoTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RateLimitError extends MobileMoneyError {
  constructor(
    message: string,
    optionsOrDetails?: MobileMoneyErrorOptions | unknown,
    providerErrorCode?: string,
    requestId?: string,
    statusCode?: number
  ) {
    const opts = resolveOptions(429, "RATE_LIMIT_EXCEEDED", optionsOrDetails, providerErrorCode, requestId, statusCode);
    super(message, opts);
    this.name = "RateLimitError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends MobileMoneyError {
  constructor(
    message: string,
    optionsOrDetails?: MobileMoneyErrorOptions | unknown,
    providerErrorCode?: string,
    requestId?: string,
    statusCode?: number
  ) {
    const opts = resolveOptions(400, "VALIDATION_ERROR", optionsOrDetails, providerErrorCode, requestId, statusCode);
    super(message, opts);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends MobileMoneyError {
  constructor(
    message: string,
    optionsOrDetails?: MobileMoneyErrorOptions | unknown,
    providerErrorCode?: string,
    requestId?: string,
    statusCode?: number
  ) {
    const opts = resolveOptions(404, "NOT_FOUND", optionsOrDetails, providerErrorCode, requestId, statusCode);
    super(message, opts);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Parses HTTP response error payloads and instantiates the corresponding typed error class
 */
export function parseApiError(
  status: number,
  data: unknown,
  headers?: Record<string, string>
): MobileMoneyError {
  let message = `HTTP request failed with status ${status}`;
  let providerErrorCode: string | undefined;
  let requestId: string | undefined;

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (lower === "x-request-id" || lower === "request-id") {
        requestId = value;
      }
    }
  }

  if (typeof data === "object" && data !== null) {
    const d = data as Record<string, any>;
    if (d.message && typeof d.message === "string") {
      message = d.message;
    } else if (d.error && typeof d.error === "string") {
      message = d.error;
    } else if (d.detail && typeof d.detail === "string") {
      message = d.detail;
    }

    providerErrorCode =
      d.providerErrorCode ||
      d.provider_error_code ||
      d.code ||
      d.error_code ||
      d.providerCode;

    if (!requestId && (d.requestId || d.request_id)) {
      requestId = d.requestId || d.request_id;
    }
  } else if (typeof data === "string" && data.trim().length > 0) {
    message = data;
  }

  const normalizedCode = (providerErrorCode || "").toUpperCase();

  const errorOpts: MobileMoneyErrorOptions = {
    statusCode: status,
    providerErrorCode,
    requestId,
    details: data,
  };

  // 1. Authentication
  if (status === 401 || normalizedCode === "AUTHENTICATION_FAILED" || normalizedCode === "UNAUTHORIZED") {
    return new AuthenticationError(message, errorOpts);
  }

  // 2. Rate Limit
  if (status === 429 || normalizedCode === "RATE_LIMIT_EXCEEDED" || normalizedCode === "TOO_MANY_REQUESTS") {
    return new RateLimitError(message, errorOpts);
  }

  // 3. Telco Timeout / Gateway Timeout
  if (
    status === 504 ||
    status === 408 ||
    normalizedCode === "TELCO_TIMEOUT" ||
    normalizedCode === "GATEWAY_TIMEOUT" ||
    normalizedCode === "TIMEOUT"
  ) {
    return new TelcoTimeoutError(message, errorOpts);
  }

  // 4. Insufficient Funds
  if (
    status === 402 ||
    normalizedCode === "INSUFFICIENT_FUNDS" ||
    normalizedCode === "LOW_BALANCE" ||
    (status === 400 && normalizedCode.includes("INSUFFICIENT_FUNDS"))
  ) {
    return new InsufficientFundsError(message, errorOpts);
  }

  // 5. Not Found
  if (status === 404 || normalizedCode === "NOT_FOUND") {
    return new NotFoundError(message, errorOpts);
  }

  // 6. Validation Error
  if (status === 400 || normalizedCode === "VALIDATION_ERROR" || normalizedCode === "INVALID_REQUEST") {
    return new ValidationError(message, errorOpts);
  }

  return new MobileMoneyError(message, errorOpts);
}
