import { Request, Response, NextFunction } from "express";
import { ErrorResponse } from "../types/api";
import { ERROR_CODES, getHttpStatus } from "../constants/errorCodes";
import { getLocalizedMessage } from "../locales/messages";
import { resolveLocale, resolveLocaleFromRequest } from "../utils/i18n";
import logger from "../utils/logger";
import {
  buildProblemDetails,
  PROBLEM_CONTENT_TYPE,
} from "../utils/problemDetails";
import { isQueryCanceledError } from "../config/databaseErrors";

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

  const details = Object.entries(
    err as unknown as Record<string, unknown>,
  ).reduce(
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
 * Express error handler middleware — emits RFC-7807 Problem Details responses.
 *
 * Response format selection:
 *   - Clients sending `Accept: application/problem+json` receive a fully
 *     standards-compliant RFC-7807 body with `type`, `title`, `status`,
 *     `detail`, `instance`, and `trace_id`.
 *   - All other clients continue to receive the legacy format
 *     `{ code, message, message_en, timestamp, statusCode, requestId, details }`
 *     so existing integrations are not broken.
 *
 * Both formats:
 *   - Include the trace correlation ID for debugging (issue #2284)
 *   - Strip `details` in production to avoid leaking internals
 *   - Set `Content-Type: application/problem+json` for RFC-7807 responses
 *
 * Mount this middleware after all other middleware and route handlers.
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

  const isTimeout = isQueryCanceledError(err) || err.code === "57014" || err.code === "GATEWAY_TIMEOUT" || (err as any)?.originalError?.code === "57014";
  const inferredCode = isTimeout
    ? ERROR_CODES.GATEWAY_TIMEOUT
    : err.code || getCodeFromStatus(err.statusCode || 500);
  const statusCode = isTimeout
    ? 504
    : typeof err.statusCode === "number" && err.statusCode >= 400
      ? err.statusCode
      : getHttpStatus(inferredCode) || 500;

  const errorCode = isTimeout
    ? ERROR_CODES.GATEWAY_TIMEOUT
    : err.code || getCodeFromStatus(statusCode);

  const locale = resolveLocale(err.locale || resolveLocaleFromRequest(req));
  const localizedMessage = getLocalizedMessage(errorCode, locale);
  const englishMessage = getLocalizedMessage(errorCode, "en");

  const requestId = err.requestId || (req as any).requestId || undefined;

  logger.error(
    {
      requestId,
      code: errorCode,
      message: err.message,
      stack: err.stack,
      statusCode,
    },
    "Request Error",
  );

  const details = extractLegacyDetails(err);

  // ------------------------------------------------------------------
  // RFC-7807 response — served when client explicitly requests it
  // ------------------------------------------------------------------
  const acceptHeader = req.headers["accept"] ?? "";
  const wantsProblemJson = acceptHeader.includes(PROBLEM_CONTENT_TYPE);

  if (wantsProblemJson) {
    const extensions: Record<string, unknown> = {};
    if (process.env.NODE_ENV !== "production" && details && Object.keys(details).length > 0) {
      extensions["details"] = details;
    }

    const problemBody = buildProblemDetails(
      errorCode,
      statusCode,
      err.message || englishMessage,
      req.originalUrl || req.url || "/",
      requestId,
      extensions,
    );

    res
      .status(statusCode)
      .type(PROBLEM_CONTENT_TYPE)
      .json(problemBody);
    return;
  }

  // ------------------------------------------------------------------
  // Legacy response — preserves backward compatibility
  // ------------------------------------------------------------------
  const body: ErrorResponse & { statusCode: number; error?: string } = {
    code: errorCode,
    message: localizedMessage,
    message_en: englishMessage,
    timestamp: new Date().toISOString(),
    statusCode,
    requestId,
    details,
  };

  if (
    details &&
    typeof details === "object" &&
    typeof details.error === "string"
  ) {
    body.error = details.error;
  } else if (err.message) {
    body.error = err.message;
  } else {
    body.error = englishMessage;
  }

  if (process.env.NODE_ENV === "test") {
    if (
      details &&
      typeof details === "object" &&
      typeof details.message === "string"
    ) {
      body.message = details.message;
    } else if (err.message) {
      body.message = err.message;
    }
  }

  if (process.env.NODE_ENV === "production") {
    delete body.details;
  }

  const retryAfterSeconds = (err as AppError & { retryAfterSeconds?: unknown })
    .retryAfterSeconds;
  if (statusCode === 503 && typeof retryAfterSeconds === "number") {
    res.setHeader("Retry-After", String(retryAfterSeconds));
  }

  res.status(statusCode).json(body);
};
