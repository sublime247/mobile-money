/**
 * Stellar memo validation utilities
 */

export type MemoType = "text" | "id" | "hash" | "none";

export interface MemoValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a Stellar memo structure and format based on its type.
 * - text: string of up to 28 bytes
 * - id: unsigned 64-bit integer string or number
 * - hash: 32-byte hex string (64 hex characters)
 */
export function validateMemo(memoType: string | undefined, memoValue: unknown): MemoValidationResult {
  if (!memoType || memoType === "none") {
    if (memoValue !== undefined && memoValue !== null && memoValue !== "") {
      return { valid: false, error: "Memo value provided but memoType is none or missing" };
    }
    return { valid: true };
  }

  const normalizedType = memoType.toLowerCase();

  if (normalizedType === "text") {
    if (typeof memoValue !== "string") {
      return { valid: false, error: "Text memo must be a string" };
    }
    // UTF-8 string up to 28 bytes
    const byteLength = Buffer.byteLength(memoValue, "utf8");
    if (byteLength === 0 || byteLength > 28) {
      return { valid: false, error: "Text memo must be between 1 and 28 bytes" };
    }
    return { valid: true };
  }

  if (normalizedType === "id") {
    if (typeof memoValue !== "string" && typeof memoValue !== "number") {
      return { valid: false, error: "ID memo must be a string or number" };
    }
    const strVal = String(memoValue);
    if (!/^\d+$/.test(strVal)) {
      return { valid: false, error: "ID memo must be a valid unsigned 64-bit integer string" };
    }
    try {
      const num = BigInt(strVal);
      if (num < 0n || num > 18446744073709551615n) {
        return { valid: false, error: "ID memo out of range for 64-bit unsigned integer" };
      }
    } catch {
      return { valid: false, error: "Invalid ID memo format" };
    }
    return { valid: true };
  }

  if (normalizedType === "hash") {
    if (typeof memoValue !== "string") {
      return { valid: false, error: "Hash memo must be a hex string" };
    }
    if (!/^[0-9a-fA-F]{64}$/.test(memoValue)) {
      return { valid: false, error: "Hash memo must be a 64-character hex string (32 bytes)" };
    }
    return { valid: true };
  }

  return { valid: false, error: `Unsupported memo type: ${memoType}` };
}

/**
 * Checks if deposit/payment requires a memo based on destination requirements.
 */
export function requireMemoCheck(requiresMemo: boolean, memoType: string | undefined, memoValue: unknown): MemoValidationResult {
  if (requiresMemo) {
    if (!memoType || memoType === "none" || memoValue === undefined || memoValue === null || memoValue === "") {
      return { valid: false, error: "Destination account requires a memo, but none was provided" };
    }
  }
  return validateMemo(memoType, memoValue);
}
