export function unwrapDatabaseError(error: unknown): unknown {
  if (
    error &&
    typeof error === "object" &&
    "originalError" in error &&
    (error as { originalError?: unknown }).originalError
  ) {
    return unwrapDatabaseError(
      (error as { originalError: unknown }).originalError,
    );
  }

  return error;
}

export function isTransientDatabaseConnectionError(error: unknown): boolean {
  const unwrappedError = unwrapDatabaseError(error);
  if (!unwrappedError || typeof unwrappedError !== "object") return false;

  const candidate = unwrappedError as { code?: string; message?: string };
  const code = candidate.code?.toUpperCase() ?? "";
  const message = candidate.message?.toLowerCase() ?? "";

  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "57P01" ||
    code === "08006" ||
    message.includes("connection terminated") ||
    message.includes("terminated unexpectedly") ||
    message.includes("connection lost") ||
    message.includes("disconnect") ||
    message.includes("connection timeout") ||
    message.includes("timeout exceeded") ||
    message.includes("socket")
  );
}

const RETRYABLE_DATABASE_CODES = new Set([
  "40P01",
  "55P03",
  "57014",
  "40001",
]);

const RETRYABLE_DATABASE_MESSAGE_HINTS = [
  "deadlock detected",
  "canceling statement due to lock timeout",
  "canceling statement due to statement timeout",
  "could not obtain lock",
  "lock not available",
  "lock timeout",
  "statement timeout",
  "serialization failure",
];

export function isRetryableDatabaseError(error: unknown): boolean {
  const unwrappedError = unwrapDatabaseError(error);
  if (!unwrappedError || typeof unwrappedError !== "object") return false;

  const candidate = unwrappedError as { code?: string; message?: string };
  const code = candidate.code?.toUpperCase() ?? "";
  const message = candidate.message?.toLowerCase() ?? "";

  return (
    RETRYABLE_DATABASE_CODES.has(code) ||
    RETRYABLE_DATABASE_MESSAGE_HINTS.some((hint) => message.includes(hint))
  );
}
