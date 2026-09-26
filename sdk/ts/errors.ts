/**
 * Custom error hierarchy for @stellar-bridge/sdk
 */

export class BridgeError extends Error {
  public readonly status?: number;
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(message: string, status?: number, code?: string, details?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, BridgeError.prototype);
  }
}

export class AuthenticationError extends BridgeError {
  constructor(message: string, details?: unknown) {
    super(message, 401, "AUTHENTICATION_FAILED", details);
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

export class ValidationError extends BridgeError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "VALIDATION_ERROR", details);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class NotFoundError extends BridgeError {
  constructor(message: string, details?: unknown) {
    super(message, 404, "NOT_FOUND", details);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}
