import { ERROR_CODES } from "../../../../constants/errorCodes";

export interface TigoErrorEntry {
  errorCode: string;
  message: string;
  retryable: boolean;
}

/**
 * Maps Tigo HTTP status codes to internal global error codes.
 *
 * Tigo's REST API signals errors primarily via HTTP status codes.
 * These mappings align those codes with the platform's global error matrix.
 */
export const TIGO_HTTP_ERROR_MATRIX: Record<number, TigoErrorEntry> = {
  400: {
    errorCode: ERROR_CODES.INVALID_INPUT,
    message: "Bad request — invalid parameters sent to Tigo API",
    retryable: false,
  },
  401: {
    errorCode: ERROR_CODES.UNAUTHORIZED,
    message: "Tigo API authentication failed — token missing or expired",
    retryable: true,
  },
  403: {
    errorCode: ERROR_CODES.FORBIDDEN,
    message: "Access denied by Tigo API — insufficient permissions",
    retryable: false,
  },
  404: {
    errorCode: ERROR_CODES.NOT_FOUND,
    message: "Resource not found on Tigo API",
    retryable: false,
  },
  409: {
    errorCode: ERROR_CODES.CONFLICT,
    message: "Conflicting request — transaction may already exist",
    retryable: false,
  },
  422: {
    errorCode: ERROR_CODES.UNPROCESSABLE_CONTENT,
    message: "Request was well-formed but contains semantic errors",
    retryable: false,
  },
  429: {
    errorCode: ERROR_CODES.RATE_LIMIT,
    message: "Tigo API rate limit exceeded — slow down requests",
    retryable: true,
  },
  500: {
    errorCode: ERROR_CODES.INTERNAL_ERROR,
    message: "Tigo API internal server error",
    retryable: true,
  },
  502: {
    errorCode: ERROR_CODES.PROVIDER_ERROR,
    message: "Tigo API gateway error",
    retryable: true,
  },
  503: {
    errorCode: ERROR_CODES.SERVICE_UNAVAILABLE,
    message: "Tigo API service temporarily unavailable",
    retryable: true,
  },
};

/**
 * Maps Tigo transaction status strings (returned by the status endpoint)
 * to the platform's canonical transaction states and global error codes.
 */
export const TIGO_TRANSACTION_STATUS_MATRIX: Record<
  string,
  { status: "completed" | "failed" | "pending"; errorCode?: string }
> = {
  SUCCESSFUL: { status: "completed" },
  SUCCESS: { status: "completed" },
  COMPLETED: { status: "completed" },
  FAILED: { status: "failed", errorCode: ERROR_CODES.TRANSACTION_FAILED },
  FAIL: { status: "failed", errorCode: ERROR_CODES.TRANSACTION_FAILED },
  CANCELLED: { status: "failed", errorCode: ERROR_CODES.TRANSACTION_FAILED },
  EXPIRED: { status: "failed", errorCode: ERROR_CODES.TRANSACTION_FAILED },
  REJECTED: { status: "failed", errorCode: ERROR_CODES.TRANSACTION_FAILED },
  PENDING: { status: "pending" },
  PROCESSING: { status: "pending" },
};

/**
 * Resolves a Tigo HTTP status code to a global error entry.
 * Returns undefined for 2xx codes (success range).
 */
export function resolveTigoHttpError(
  httpStatus: number,
): TigoErrorEntry | undefined {
  if (httpStatus >= 200 && httpStatus < 300) return undefined;
  return (
    TIGO_HTTP_ERROR_MATRIX[httpStatus] ?? {
      errorCode: ERROR_CODES.PROVIDER_ERROR,
      message: `Unexpected Tigo API response with HTTP status ${httpStatus}`,
      retryable: false,
    }
  );
}

/**
 * Resolves a Tigo transaction status string to a canonical status and optional error code.
 */
export function resolveTigoTransactionStatus(rawStatus: string): {
  status: "completed" | "failed" | "pending" | "unknown";
  errorCode?: string;
} {
  const entry = TIGO_TRANSACTION_STATUS_MATRIX[rawStatus.toUpperCase()];
  return entry ?? { status: "unknown" };
}
