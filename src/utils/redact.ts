/**
 * Centralized log redaction utility.
 *
 * Recursively walks any value and replaces the content of fields whose names
 * match a known-sensitive pattern with the string "[REDACTED]".
 *
 * Design goals:
 *  - Zero mutations — always returns a deep clone.
 *  - Case-insensitive, partial-match field name detection (e.g. "accessToken",
 *    "X-Api-Key", "newPassword" all match).
 *  - Handles nested objects, arrays, stringified JSON embedded in string
 *    values, and Error objects.
 *  - No external dependencies — pure Node.js / TypeScript.
 */

export const REDACTED = "[REDACTED]";

/**
 * Patterns that identify sensitive field names.
 * Each entry is tested case-insensitively against the full field name, so a
 * partial match (e.g. "accessToken" contains "token") is sufficient.
 */
export const REDACT_KEYS: string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api-key",
  "api_key",
  "privatekey",
  "private-key",
  "private_key",
  "mnemonic",
  "seed",
  "authorization",
  "auth",
  "credential",
  "pin",
  "otp",
  "passphrase",
  "cookie",
  "x-api-key",
  "accesskey",
  "access-key",
  "access_key",
  "clientsecret",
  "client-secret",
  "client_secret",
  "refreshtoken",
  "refresh-token",
  "refresh_token",
  "idtoken",
  "id-token",
  "id_token",
  "bearer",
  "signature",
  "signingkey",
  "signing-key",
  "signing_key",
  "encryptionkey",
  "encryption-key",
  "encryption_key",
  "masterkey",
  "master-key",
  "master_key",
  "walletkey",
  "wallet-key",
  "wallet_key",
  "stellarsecret",
  "stellar-secret",
  "stellar_secret",
  "stellarseed",
  "stellar-seed",
  "stellar_seed",
  "ssn",
  "cvv",
  "cardnumber",
  "card-number",
  "card_number",
  "accountnumber",
  "account-number",
  "account_number",
  // ── PII master keys (#1335) ───────────────────────────────────────────────
  // Government-issued identifiers
  "ssn", "national_id", "national-id", "national_id_number",
  "passport_number", "passport-number",
  "tax_id", "tax-id", "taxpayer_id",
  "drivers_license", "driving_license", "driver_license",
  "voter_id", "voter-id",
  // Financial / payment PII
  "iban", "sort_code", "sort-code", "routing_number", "routing-number",
  "bank_account", "bank-account",
  "swift_code", "swift-code", "bic",
  // Biometric / health
  "dob", "date_of_birth", "date-of-birth", "birth_date", "birthdate",
  "biometric", "fingerprint", "face_id", "face-id",
  // Contact PII
  "email", "phone", "phone_number", "phone-number",
  "address", "street", "postcode", "postal_code", "postal-code", "zip",
  "full_name", "full-name", "first_name", "last_name",
  // Crypto / wallet
  "stellar_address", "stellar-address",
  "wallet_address", "wallet-address",
  "private_key", "public_key",
  "transaction_hash", "tx_hash",
  // Session / device
  "session_id", "session-id",
  "device_id", "device-id",
  "ip_address", "ip-address",
  "user_agent", "user-agent",
];

/**
 * PII_MASTER_KEYS — the complete set of field names that must NEVER appear
 * in logs at any verbosity level, including DEBUG.
 *
 * This is the authoritative source of truth for the log scrubbing config.
 * Any new PII field MUST be added here before being used in code.
 */
export const PII_MASTER_KEYS: ReadonlySet<string> = new Set(REDACT_KEYS);

/**
 * Patterns that identify sensitive field names.
 * Each entry is tested case-insensitively against the full field name, so a
 * partial match (e.g. "accessToken" contains "token") is sufficient.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  ...REDACT_KEYS.map((key) => {
    if (key === "pin") return /pin\b/i;
    if (key === "otp") return /\botp\b/i;
    return new RegExp(key.replace(/[_-]/g, "[_-]?"), "i");
  }),
];

/**
 * Returns true when a field name should have its value redacted.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Attempts to parse a string as a JSON object or array.
 * Returns the parsed value on success, or null if the string is not valid JSON
 * or does not parse to an object/array (primitives are left as-is).
 */
function tryParseJson(value: string): Record<string, unknown> | unknown[] | null {
  const trimmed = value.trim();
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown> | unknown[];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Core recursive redaction function.
 *
 * @param value   - Any value to redact.
 * @param _key    - The field name under which this value lives (used by the
 *                  parent call to decide whether to redact).
 * @returns A deep clone of `value` with sensitive fields replaced.
 */
export function redact(value: unknown, _key?: string): unknown {
  // ── Null / undefined ──────────────────────────────────────────────────────
  if (value === null || value === undefined) {
    return value;
  }

  // ── Error objects ─────────────────────────────────────────────────────────
  // Serialize to a plain object so the recursive walk can inspect its fields.
  if (value instanceof Error) {
    const plain: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    // Copy any enumerable extra properties (e.g. code, statusCode, details).
    for (const k of Object.keys(value as unknown as Record<string, unknown>)) {
      plain[k] = (value as unknown as Record<string, unknown>)[k];
    }
    return redact(plain);
  }

  // ── Arrays ────────────────────────────────────────────────────────────────
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  // ── Plain objects ─────────────────────────────────────────────────────────
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = isSensitiveKey(k) ? REDACTED : redact(v, k);
    }
    return result;
  }

  // ── Strings ───────────────────────────────────────────────────────────────
  // If the string looks like a JSON object/array, parse and redact it, then
  // re-serialize so the log entry stays valid JSON.
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed !== null) {
      return JSON.stringify(redact(parsed));
    }
    return value;
  }

  // ── Primitives (number, boolean, bigint, symbol) ──────────────────────────
  return value;
}
