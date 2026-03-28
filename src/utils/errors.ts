import { AppError, createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";

export class ValidationError extends Error implements AppError {
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string = ERROR_CODES.INVALID_INPUT,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.statusCode = 400;
    this.details = details;
  }
}

export class AuthenticationError extends Error implements AppError {
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string = ERROR_CODES.UNAUTHORIZED,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
    this.statusCode = 401;
    this.details = details;
  }
}

export class AuthorizationError extends Error implements AppError {
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string = ERROR_CODES.FORBIDDEN,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
    this.statusCode = 403;
    this.details = details;
  }
}

export class NotFoundError extends Error implements AppError {
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string = ERROR_CODES.NOT_FOUND,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NotFoundError";
    this.code = code;
    this.statusCode = 404;
    this.details = details;
  }
}

export class ConflictError extends Error implements AppError {
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string = ERROR_CODES.CONFLICT,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConflictError";
    this.code = code;
    this.statusCode = 409;
    this.details = details;
  }
}

export class BusinessLogicError extends Error implements AppError {
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BusinessLogicError";
    this.code = code;
    this.statusCode = getStatusForCode(code);
    this.details = details;
  }
}

const getStatusForCode = (code: string): number => {
  if (code === ERROR_CODES.LIMIT_EXCEEDED || code === ERROR_CODES.RATE_LIMIT) {
    return 429;
  }
  if (code === ERROR_CODES.PROVIDER_ERROR) {
    return 502;
  }
  return 400;
};

export { createError };