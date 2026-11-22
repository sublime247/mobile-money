import { ERROR_CODES } from "../../../constants/errorCodes";

export interface MoovErrorEntry {
  errorCode: string;
  message: string;
  retryable: boolean;
}

/**
 * Maps Moov Côte d'Ivoire deposit-push error responses to internal global
 * error codes.
 *
 * Moov's REST API surfaces failures either as a non-2xx HTTP status with a
 * `{ code, message }` body, or (for some validation failures) as a 200 with
 * an embedded `status: "FAILED"` and a `code` field — this matrix maps the
 * `code` value regardless of which shape produced it.
 */
export const MOOV_ERROR_MATRIX: Record<string, MoovErrorEntry> = {
  INSUFFICIENT_BALANCE: {
    errorCode: ERROR_CODES.INSUFFICIENT_BALANCE,
    message: "Insufficient balance in the Moov Money account",
    retryable: false,
  },
  INVALID_MSISDN: {
    errorCode: ERROR_CODES.INVALID_PHONE_FORMAT,
    message: "Invalid or unregistered Côte d'Ivoire phone number",
    retryable: false,
  },
  INVALID_AMOUNT: {
    errorCode: ERROR_CODES.INVALID_AMOUNT,
    message: "Invalid deposit amount",
    retryable: false,
  },
  DUPLICATE_REFERENCE: {
    errorCode: ERROR_CODES.DUPLICATE_REQUEST,
    message: "Duplicate transaction reference",
    retryable: false,
  },
  ACCOUNT_SUSPENDED: {
    errorCode: ERROR_CODES.FORBIDDEN,
    message: "Moov Money account is suspended",
    retryable: false,
  },
  LIMIT_EXCEEDED: {
    errorCode: ERROR_CODES.LIMIT_EXCEEDED,
    message: "Transaction exceeds the allowed Moov Money limit",
    retryable: false,
  },
  UNAUTHORIZED: {
    errorCode: ERROR_CODES.UNAUTHORIZED,
    message: "Moov Côte d'Ivoire authentication failed",
    retryable: false,
  },
  SERVICE_UNAVAILABLE: {
    errorCode: ERROR_CODES.SERVICE_UNAVAILABLE,
    message: "Moov Money service is temporarily unavailable",
    retryable: true,
  },
  TIMEOUT: {
    errorCode: ERROR_CODES.PROVIDER_ERROR,
    message: "Moov Money request timed out",
    retryable: true,
  },
  PIN_TIMEOUT: {
    errorCode: ERROR_CODES.PROVIDER_ERROR,
    message: "Customer did not enter their PIN in time on the USSD prompt",
    retryable: true,
  },
  INTERNAL_ERROR: {
    errorCode: ERROR_CODES.INTERNAL_ERROR,
    message: "Moov internal processing error",
    retryable: true,
  },
};

/**
 * HTTP status codes that, absent a more specific `code` in the response
 * body, indicate insufficient balance for a Moov deposit push. 402 is the
 * standard "Payment Required" status; some Moov environments return 400
 * with no body code at all for the same condition.
 */
const INSUFFICIENT_BALANCE_STATUS_CODES = new Set([402]);

/**
 * Resolves a Moov error `code` (from the response body) to a global error
 * entry. Returns undefined for an unrecognised code — callers should fall
 * back to a generic message in that case, not assume insufficient balance.
 */
export function resolveMoovError(
  code: string | undefined | null,
): MoovErrorEntry | undefined {
  if (!code) return undefined;
  return MOOV_ERROR_MATRIX[code];
}

/**
 * Resolves a Moov failure using both the response body `code` (preferred,
 * exact) and the HTTP status (fallback, for the case where Moov returns a
 * bare 402/400 with no machine-readable code). Returns undefined only when
 * neither signal maps to a known condition — callers should keep their
 * existing generic-failure message in that case.
 */
export function resolveMoovErrorFromResponse(
  code: string | undefined | null,
  httpStatus: number | undefined,
): MoovErrorEntry | undefined {
  const byCode = resolveMoovError(code);
  if (byCode) return byCode;

  if (
    httpStatus !== undefined &&
    INSUFFICIENT_BALANCE_STATUS_CODES.has(httpStatus)
  ) {
    return MOOV_ERROR_MATRIX.INSUFFICIENT_BALANCE;
  }

  return undefined;
}
