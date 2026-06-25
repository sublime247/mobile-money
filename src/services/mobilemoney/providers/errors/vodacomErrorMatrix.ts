import { ERROR_CODES } from "../../../../constants/errorCodes";

export interface VodacomErrorEntry {
  errorCode: string;
  message: string;
  retryable: boolean;
}

/**
 * Maps Vodacom M-Pesa OpenAPI INS-* response codes to internal global error codes.
 *
 * INS-0 is the only success code; all others represent error conditions.
 * Source: Vodacom OpenAPI M-Pesa documentation (TanzaniaN market).
 */
export const VODACOM_ERROR_MATRIX: Record<string, VodacomErrorEntry> = {
  "INS-1": {
    errorCode: ERROR_CODES.INTERNAL_ERROR,
    message: "Internal error occurred on Vodacom side",
    retryable: true,
  },
  "INS-2": {
    errorCode: ERROR_CODES.INSUFFICIENT_BALANCE,
    message: "Insufficient balance in the account",
    retryable: false,
  },
  "INS-3": {
    errorCode: ERROR_CODES.TRANSACTION_FAILED,
    message: "Account is not active",
    retryable: false,
  },
  "INS-4": {
    errorCode: ERROR_CODES.FORBIDDEN,
    message: "Service not allowed for this account",
    retryable: false,
  },
  "INS-5": {
    errorCode: ERROR_CODES.INVALID_INPUT,
    message: "Invalid language code provided",
    retryable: false,
  },
  "INS-6": {
    errorCode: ERROR_CODES.INVALID_PHONE_FORMAT,
    message: "Invalid or unregistered MSISDN (phone number)",
    retryable: false,
  },
  "INS-9": {
    errorCode: ERROR_CODES.INVALID_AMOUNT,
    message: "Invalid transaction amount",
    retryable: false,
  },
  "INS-10": {
    errorCode: ERROR_CODES.DUPLICATE_REQUEST,
    message: "Duplicate transaction detected",
    retryable: false,
  },
  "INS-13": {
    errorCode: ERROR_CODES.INVALID_INPUT,
    message: "Invalid transaction reference",
    retryable: false,
  },
  "INS-14": {
    errorCode: ERROR_CODES.UNAUTHORIZED,
    message: "Session ID is invalid or has expired",
    retryable: true,
  },
  "INS-15": {
    errorCode: ERROR_CODES.MISSING_FIELD,
    message: "Required request parameter is missing",
    retryable: false,
  },
  "INS-17": {
    errorCode: ERROR_CODES.CONFLICT,
    message: "Transaction reference has already been used",
    retryable: false,
  },
  "INS-18": {
    errorCode: ERROR_CODES.INVALID_INPUT,
    message: "Invalid market code in request",
    retryable: false,
  },
  "INS-19": {
    errorCode: ERROR_CODES.NOT_FOUND,
    message: "Initiator identifier not found",
    retryable: false,
  },
  "INS-20": {
    errorCode: ERROR_CODES.UNAUTHORIZED,
    message: "Authentication error — bad credentials",
    retryable: false,
  },
  "INS-21": {
    errorCode: ERROR_CODES.INTERNAL_ERROR,
    message: "Vodacom internal processing error",
    retryable: true,
  },
  "INS-22": {
    errorCode: ERROR_CODES.PROVIDER_ERROR,
    message: "Vodacom application error",
    retryable: true,
  },
  "INS-23": {
    errorCode: ERROR_CODES.LIMIT_EXCEEDED,
    message: "Transaction amount exceeds the allowed limit",
    retryable: false,
  },
  "INS-24": {
    errorCode: ERROR_CODES.SERVICE_UNAVAILABLE,
    message: "Vodacom system is overloaded — try again later",
    retryable: true,
  },
  "INS-26": {
    errorCode: ERROR_CODES.RATE_LIMIT,
    message: "Too many requests — rate limit exceeded",
    retryable: true,
  },
  "INS-996": {
    errorCode: ERROR_CODES.FORBIDDEN,
    message: "API not enabled for this account",
    retryable: false,
  },
  "INS-997": {
    errorCode: ERROR_CODES.UNAUTHORIZED,
    message: "Could not authenticate the API key",
    retryable: false,
  },
  "INS-998": {
    errorCode: ERROR_CODES.INVALID_CREDENTIALS,
    message: "Missing or invalid API credentials",
    retryable: false,
  },
  "INS-999": {
    errorCode: ERROR_CODES.TRANSACTION_FAILED,
    message: "Transaction was cancelled",
    retryable: false,
  },
};

/**
 * Resolves a Vodacom INS-* response code to a global error entry.
 * Returns undefined for INS-0 (success) and unknown codes.
 */
export function resolveVodacomError(
  insCode: string,
): VodacomErrorEntry | undefined {
  if (insCode === "INS-0") return undefined;
  return (
    VODACOM_ERROR_MATRIX[insCode] ?? {
      errorCode: ERROR_CODES.PROVIDER_ERROR,
      message: `Unrecognised Vodacom response code: ${insCode}`,
      retryable: false,
    }
  );
}
