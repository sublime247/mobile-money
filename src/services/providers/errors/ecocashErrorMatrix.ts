import { ERROR_CODES } from "../../../constants/errorCodes";

export interface EcoCashErrorEntry {
  errorCode: string;
  message: string;
  retryable: boolean;
}

/**
 * Maps Econet EcoCash disbursement/status error responses to internal
 * global error codes, matching the shape of moovErrorMatrix.ts.
 *
 * EcoCash's merchant gateway surfaces failures as a non-2xx HTTP status
 * with a `{ resultCode, resultDesc }` body -- this matrix maps the
 * `resultCode` value.
 */
export const ECOCASH_ERROR_MATRIX: Record<string, EcoCashErrorEntry> = {
  INS_1: {
    errorCode: ERROR_CODES.INSUFFICIENT_BALANCE,
    message: "Insufficient balance in the EcoCash merchant account",
    retryable: false,
  },
  INS_2: {
    errorCode: ERROR_CODES.INVALID_PHONE_FORMAT,
    message: "Invalid or unregistered EcoCash subscriber number",
    retryable: false,
  },
  INS_3: {
    errorCode: ERROR_CODES.INVALID_AMOUNT,
    message: "Invalid disbursement amount",
    retryable: false,
  },
  INS_4: {
    errorCode: ERROR_CODES.DUPLICATE_REQUEST,
    message: "Duplicate disbursement reference",
    retryable: false,
  },
  INS_5: {
    errorCode: ERROR_CODES.FORBIDDEN,
    message: "EcoCash merchant account is suspended",
    retryable: false,
  },
  INS_6: {
    errorCode: ERROR_CODES.LIMIT_EXCEEDED,
    message: "Disbursement exceeds the allowed EcoCash limit",
    retryable: false,
  },
  INS_9: {
    errorCode: ERROR_CODES.UNAUTHORIZED,
    message: "EcoCash merchant gateway authentication failed",
    retryable: false,
  },
  INS_10: {
    errorCode: ERROR_CODES.SERVICE_UNAVAILABLE,
    message: "EcoCash service is temporarily unavailable",
    retryable: true,
  },
  INS_15: {
    errorCode: ERROR_CODES.PROVIDER_ERROR,
    message: "EcoCash disbursement request timed out",
    retryable: true,
  },
  INS_20: {
    errorCode: ERROR_CODES.INTERNAL_ERROR,
    message: "EcoCash internal processing error",
    retryable: true,
  },
};

/**
 * HTTP status codes that, absent a more specific `resultCode` in the
 * response body, indicate a known condition for an EcoCash disbursement.
 */
const INSUFFICIENT_BALANCE_STATUS_CODES = new Set([402]);

/**
 * Resolves an EcoCash `resultCode` (from the response body) to a global
 * error entry. Returns undefined for an unrecognised code -- callers
 * should fall back to a generic message, not assume a specific condition.
 */
export function resolveEcoCashError(
  resultCode: string | undefined | null,
): EcoCashErrorEntry | undefined {
  if (!resultCode) return undefined;
  return ECOCASH_ERROR_MATRIX[resultCode];
}

/**
 * Resolves an EcoCash failure using both the response body `resultCode`
 * (preferred, exact) and the HTTP status (fallback). Returns undefined
 * only when neither signal maps to a known condition.
 */
export function resolveEcoCashErrorFromResponse(
  resultCode: string | undefined | null,
  httpStatus: number | undefined,
): EcoCashErrorEntry | undefined {
  const byCode = resolveEcoCashError(resultCode);
  if (byCode) return byCode;

  if (
    httpStatus !== undefined &&
    INSUFFICIENT_BALANCE_STATUS_CODES.has(httpStatus)
  ) {
    return ECOCASH_ERROR_MATRIX.INS_1;
  }

  return undefined;
}
