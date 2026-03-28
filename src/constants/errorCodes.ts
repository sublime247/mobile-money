/**
 * Standardized error codes for consistent error handling across the API.
 * 
 * All error codes are organized by category (validation, authentication, etc.)
 * and automatically mapped to appropriate HTTP status codes.
 * 
 * Usage:
 * ```typescript
 * import { ERROR_CODES } from './constants/errorCodes';
 * 
 * throw createError(ERROR_CODES.INVALID_INPUT);
 * ```
 * 
 * @see getHttpStatus - For HTTP status code mapping
 * @see getLocalizedMessage - For localized error messages
 */
export const ERROR_CODES = {
    // Validation errors (4000-4099) - HTTP 400
    INVALID_INPUT: "INVALID_INPUT",
    MISSING_FIELD: "MISSING_FIELD",
    INVALID_PHONE_FORMAT: "INVALID_PHONE_FORMAT",
    INVALID_AMOUNT: "INVALID_AMOUNT",
  
    // Authentication errors (4010-4019) - HTTP 401
    UNAUTHORIZED: "UNAUTHORIZED",
    INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
    TOKEN_EXPIRED: "TOKEN_EXPIRED",
    INVALID_TOKEN: "INVALID_TOKEN",
  
    // Authorization errors (4030-4039) - HTTP 403
    FORBIDDEN: "FORBIDDEN",
    INSUFFICIENT_PERMISSIONS: "INSUFFICIENT_PERMISSIONS",
  
    // Resource errors (4040-4049) - HTTP 404
    NOT_FOUND: "NOT_FOUND",
    RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
    TRANSACTION_NOT_FOUND: "TRANSACTION_NOT_FOUND",
  
    // Conflict errors (4090-4099) - HTTP 409
    CONFLICT: "CONFLICT",
    DUPLICATE_REQUEST: "DUPLICATE_REQUEST",
    TRANSACTION_EXISTS: "TRANSACTION_EXISTS",
  
    // Business logic errors (4200-4299) - Various
    LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
    INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
    TRANSACTION_FAILED: "TRANSACTION_FAILED",
    PROVIDER_ERROR: "PROVIDER_ERROR",
    RATE_LIMIT: "RATE_LIMIT",
  
    // Server errors (5000+) - HTTP 500+
    INTERNAL_ERROR: "INTERNAL_ERROR",
    SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    DATABASE_ERROR: "DATABASE_ERROR",
  };
  
  /**
   * Maps error codes to appropriate HTTP status codes.
   * 
   * This function determines the correct HTTP status code based on the error type.
   * Used by the error handler middleware to set the response status.
   * 
   * **Status Code Mapping:**
   * - 400 Bad Request: Validation/input errors
   * - 401 Unauthorized: Authentication errors
   * - 403 Forbidden: Authorization/permission errors
   * - 404 Not Found: Resource not found errors
   * - 409 Conflict: State/conflict errors
   * - 429 Too Many Requests: Rate limit/quota exceeded
   * - 500 Internal Server Error: Server/database errors
   * - 502 Bad Gateway: External provider errors
   * 
   * @param {string} code - Error code to map (e.g., INVALID_INPUT, UNAUTHORIZED)
   * @returns {number} HTTP status code (defaults to 500 if code not recognized)
   * 
   * @example
   * getHttpStatus(ERROR_CODES.INVALID_INPUT); // Returns 400
   * getHttpStatus(ERROR_CODES.UNAUTHORIZED); // Returns 401
   * getHttpStatus(ERROR_CODES.LIMIT_EXCEEDED); // Returns 429
   * getHttpStatus('UNKNOWN'); // Returns 500
   */
  export const getHttpStatus = (code: string): number => {
    if (
      code.startsWith("400") ||
      code === ERROR_CODES.INVALID_INPUT ||
      code === ERROR_CODES.MISSING_FIELD ||
      code === ERROR_CODES.INVALID_PHONE_FORMAT ||
      code === ERROR_CODES.INVALID_AMOUNT
    ) {
      return 400;
    }
    if (
      code === ERROR_CODES.UNAUTHORIZED ||
      code === ERROR_CODES.INVALID_CREDENTIALS ||
      code === ERROR_CODES.TOKEN_EXPIRED ||
      code === ERROR_CODES.INVALID_TOKEN
    ) {
      return 401;
    }
    if (
      code === ERROR_CODES.FORBIDDEN ||
      code === ERROR_CODES.INSUFFICIENT_PERMISSIONS
    ) {
      return 403;
    }
    if (
      code === ERROR_CODES.NOT_FOUND ||
      code === ERROR_CODES.RESOURCE_NOT_FOUND ||
      code === ERROR_CODES.TRANSACTION_NOT_FOUND
    ) {
      return 404;
    }
    if (
      code === ERROR_CODES.CONFLICT ||
      code === ERROR_CODES.DUPLICATE_REQUEST ||
      code === ERROR_CODES.TRANSACTION_EXISTS
    ) {
      return 409;
    }
    if (code === ERROR_CODES.LIMIT_EXCEEDED || code === ERROR_CODES.RATE_LIMIT) {
      return 429;
    }
    if (code === ERROR_CODES.PROVIDER_ERROR) {
      return 502;
    }
    if (
      code.startsWith("500") ||
      code === ERROR_CODES.INTERNAL_ERROR ||
      code === ERROR_CODES.SERVICE_UNAVAILABLE ||
      code === ERROR_CODES.DATABASE_ERROR
    ) {
      return 500;
    }
    return 500;
  };