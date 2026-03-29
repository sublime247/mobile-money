import { Request, Response, NextFunction } from "express";
import { ErrorResponse } from "../types/api";
import { ERROR_CODES, getHttpStatus } from "../constants/errorCodes";
import { getLocalizedMessage } from "../locales/messages";
import { resolveLocale, resolveLocaleFromRequest } from "../utils/i18n";

/**
 * Extended Error interface with error-specific properties.
 * 
 * @interface AppError
 * @extends {Error}
 * @property {string} [code] - Standard error code (e.g., INVALID_INPUT, UNAUTHORIZED)
 * @property {number} [statusCode] - HTTP status code (auto-mapped from code if not set)
 * @property {Record<string, unknown>} [details] - Additional error context (only in development)
 * 
 * @example
 * const error: AppError = new Error("Invalid phone");
 * error.code = ERROR_CODES.INVALID_PHONE_FORMAT;
 * error.statusCode = 400;
 * error.details = { received: "+invalid" };
 */
export interface AppError extends Error {
  code?: string;
  statusCode?: number;
  details?: Record<string, unknown>;
  locale?: string;
  requestId?: string;
}

const RESERVED_ERROR_FIELDS = new Set([
  "name",
  "message",
  "stack",
  "code",
  "statusCode",
  "details",
  "locale",
  "requestId",
]);

const getCodeFromStatus = (statusCode: number): string => {
  if (statusCode === 400) return ERROR_CODES.INVALID_INPUT;
  if (statusCode === 401) return ERROR_CODES.UNAUTHORIZED;
  if (statusCode === 403) return ERROR_CODES.FORBIDDEN;
  if (statusCode === 404) return ERROR_CODES.NOT_FOUND;
  if (statusCode === 409) return ERROR_CODES.CONFLICT;
  if (statusCode === 429) return ERROR_CODES.LIMIT_EXCEEDED;
  if (statusCode === 503) return ERROR_CODES.SERVICE_UNAVAILABLE;
  return ERROR_CODES.INTERNAL_ERROR;
};

const extractLegacyDetails = (err: AppError): Record<string, unknown> => {
  if (err.details && typeof err.details === "object") {
    return err.details;
  }

  const details = Object.entries(err as Record<string, unknown>).reduce(
    (acc, [key, value]) => {
      if (!RESERVED_ERROR_FIELDS.has(key) && value !== undefined) {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, unknown>,
  );

  return details;
};

/**
 * Creates a standardized error with code, status, and optional details.
 * 
 * Automatically maps the error code to the appropriate HTTP status code.
 * 
 * @param {string} code - Standard error code from ERROR_CODES
 * @param {string} [message] - Optional error message for debugging
 * @param {Record<string, unknown>} [details] - Optional context data for the error
 * @returns {AppError} Error object ready for error handler middleware
 * 
 * @example
 * // Validation error
 * throw createError(
 *   ERROR_CODES.MISSING_FIELD,
 *   "Phone number is required",
 *   { field: "phoneNumber" }
 * );
 * 
 * // Business logic error
 * throw createError(
 *   ERROR_CODES.INSUFFICIENT_BALANCE,
 *   "Not enough funds",
 *   { balance: 100, requested: 500 }
 * );
 */
export const createError = (
  code: string,
  message?: string,
  details?: Record<string, unknown>,
): AppError => {
  const error: AppError = new Error(message);
  error.code = code;
  error.statusCode = getHttpStatus(code);
  error.details = details;
  return error;
};

/**
 * Express error handler middleware for standardized API error responses.
 * 
 * Normalizes all errors into a consistent JSON format with:
 * - **code**: Standard error code for programmatic handling
 * - **message**: Localized human-readable message based on Accept-Language header
 * - **message_en**: English fallback message (always included)
 * - **timestamp**: ISO 8601 timestamp of error occurrence
 * - **requestId**: Optional unique request identifier for tracing
 * - **details**: Optional context data (development mode only)
 * 
 * **Language Support:**
 * - Detects language from Accept-Language HTTP header
 * - Supports: English (en), French (fr), Spanish (es), Portuguese (pt)
 * - Falls back to English for unsupported languages
 * 
 * **HTTP Status Codes:**
 * - Automatically maps error codes to appropriate HTTP status codes
 * - 400: Validation/input errors
 * - 401: Authentication errors
 * - 403: Authorization/permission errors
 * - 404: Resource not found errors
 * - 409: Conflict/state errors
 * - 429: Rate limit/quota exceeded
 * - 500: Server/internal errors
 * 
 * **Production vs Development:**
 * - Production: Error details are hidden for security
 * - Development: Error details are included for debugging
 * 
 * **Usage:**
 * Mount this middleware after all other middleware and route handlers.
 * Must be last middleware to catch all errors.
 * 
 * @param {AppError} err - Error object (may include code, statusCode, details)
 * @param {Request} req - Express request object (reads Accept-Language header)
 * @param {Response} res - Express response object (writes normalized error response)
 * @param {NextFunction} _next - Express next function (unused, required for error middleware)
 * 
 * @example
 * // Setup in Express app
 * app.use(routes);
 * app.use(errorHandler); // Must be last
 * 
 * @example
 * // Response for French client with validation error
 * // Request: POST /api/transfer -H "Accept-Language: fr"
 * // Response: 400
 * {
 *   "code": "INVALID_PHONE_FORMAT",
 *   "message": "Le format du numéro de téléphone est invalide",
 *   "message_en": "Phone number format is invalid",
 *   "timestamp": "2026-03-27T10:30:00.000Z",
 *   "requestId": "req-123-abc",
 *   "details": { "received": "invalid-phone" }  // Only in development
 * }
 * 
 * @example
 * // Response for English client with business logic error
 * // Request: POST /api/withdraw -H "Accept-Language: en"
 * // Response: 429
 * {
 *   "code": "LIMIT_EXCEEDED",
 *   "message": "Daily transaction limit exceeded",
 *   "message_en": "Daily transaction limit exceeded",
 *   "timestamp": "2026-03-27T10:31:00.000Z",
 *   "requestId": "req-456-def"
 * }
 * 
 * @example
 * // Response for unsupported language (fallback to English)
 * // Request: GET /api/users/invalid -H "Accept-Language: de"
 * // Response: 404
 * {
 *   "code": "NOT_FOUND",
 *   "message": "Resource not found",
 *   "message_en": "Resource not found",
 *   "timestamp": "2026-03-27T10:32:00.000Z"
 * }
 */
export const errorHandler = (
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const responseWithLocals = res as Response & {
    locals?: Record<string, unknown>;
  };
  responseWithLocals.locals = responseWithLocals.locals || {};
  responseWithLocals.locals["__criticalError"] = err;
  const inferredCode = err.code || getCodeFromStatus(err.statusCode || 500);
  const statusCode =
    typeof err.statusCode === "number" && err.statusCode >= 400
      ? err.statusCode
      : getHttpStatus(inferredCode) || 500;

  const errorCode = err.code || getCodeFromStatus(statusCode);

  const locale = resolveLocale(err.locale || resolveLocaleFromRequest(req));
  const localizedMessage = getLocalizedMessage(errorCode, locale);
  const englishMessage = getLocalizedMessage(errorCode, "en");

  const requestId = err.requestId || (req as any).requestId || undefined;

  console.error({
    timestamp: new Date().toISOString(),
    requestId,
    code: errorCode,
    message: err.message,
    stack: err.stack,
    statusCode,
  });

  const body: ErrorResponse & { statusCode: number } = {
    code: errorCode,
    message: localizedMessage,
    message_en: englishMessage,
    timestamp: new Date().toISOString(),
    statusCode,
    requestId,
    details: extractLegacyDetails(err),
  };

  if (process.env.NODE_ENV === "production") {
    delete body.details;
  }

  res.status(statusCode).json(body);
};