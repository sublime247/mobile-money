/**
 * Payload sanitizer for provider API failure snapshots (#2445).
 *
 * Provider requests and responses carry customer PINs, OAuth tokens, national
 * ID numbers and card data. Before a failed call is persisted to
 * `provider_error_logs`, every header, body and query string goes through
 * this module, which:
 *
 *  - masks sensitive fields (pin, password, access_token, national_id, cvv,
 *    plus auth headers and other credential-style keys), whatever their
 *    casing or separator style (`accessToken`, `access-token`, `ACCESS_TOKEN`);
 *  - walks nested objects and arrays, JSON encoded in strings, and
 *    `application/x-www-form-urlencoded` bodies;
 *  - caps the serialized payload at 32KB so a huge provider response cannot
 *    exhaust memory or bloat the table.
 *
 * Pure functions with no I/O, so they are safe to call from an Axios
 * interceptor on the hot path.
 */

export const MASK = "[REDACTED]";

/** Maximum serialized size of a stored payload (request or response). */
export const MAX_PAYLOAD_BYTES = 32 * 1024;

/** Marker appended to a payload that was cut at {@link MAX_PAYLOAD_BYTES}. */
export const TRUNCATION_MARKER = "...[TRUNCATED]";

const MAX_DEPTH = 20;

/**
 * Field names that are always masked, compared after normalisation
 * (lower-cased, with `-`, `_`, `.` and spaces removed).
 */
const SENSITIVE_FIELDS = new Set(
  [
    // Required by #2445
    "pin",
    "password",
    "access_token",
    "national_id",
    "cvv",
    // Common aliases of the same data
    "pin_code",
    "user_pin",
    "customer_pin",
    "mpin",
    "old_pin",
    "new_pin",
    "passwd",
    "new_password",
    "old_password",
    "refresh_token",
    "id_token",
    "token",
    "client_secret",
    "secret",
    "api_key",
    "apikey",
    "x_api_key",
    "ocp_apim_subscription_key",
    "authorization",
    "proxy_authorization",
    "cookie",
    "set_cookie",
    "national_id_number",
    "nin",
    "id_number",
    "cvc",
    "cvv2",
    "card_number",
    "pan",
    "otp",
    "security_credential",
    "initiator_password",
    "private_key",
  ].map(normalizeKey),
);

/**
 * Normalised suffixes that also mark a field as sensitive, so names like
 * `customerPin`, `merchantPassword` or `x-session-token` are caught without
 * listing every variant.
 */
const SENSITIVE_SUFFIXES = [
  "pin",
  "password",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "secret",
  "nationalid",
  "cvv",
  "apikey",
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, "");
}

/** True when a header / body field name holds sensitive data. */
export function isSensitiveField(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (SENSITIVE_FIELDS.has(normalized)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function looksLikeFormEncoded(value: string): boolean {
  // key=value pairs joined by &, without whitespace (avoids matching prose).
  return /^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(value.trim());
}

function sanitizeFormEncoded(value: string): string {
  return value
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const rawKey = pair.slice(0, eq);
      let decodedKey = rawKey;
      try {
        decodedKey = decodeURIComponent(rawKey.replace(/\+/g, " "));
      } catch {
        // Malformed escape: fall back to the raw key.
      }
      return isSensitiveField(decodedKey) ? `${rawKey}=${MASK}` : pair;
    })
    .join("&");
}

/** Mask credential-looking values that appear inline in free text. */
function sanitizeFreeText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, `$1 ${MASK}`)
    .replace(
      /((?<![A-Za-z0-9_])"?(?:pin|password|access_token|national_id|cvv)"?\s*[:=]\s*)("[^"]*"|[^\s,&}]+)/gi,
      `$1"${MASK}"`,
    );
}

function sanitizeString(value: string, depth: number): string {
  if (looksLikeJson(value)) {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(sanitizeValue(parsed, depth + 1));
    } catch {
      // Not valid JSON after all; fall through to text handling.
    }
  }
  if (looksLikeFormEncoded(value)) {
    return sanitizeFormEncoded(value);
  }
  return sanitizeFreeText(value);
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]";

  if (typeof value === "string") return sanitizeString(value, depth);
  if (typeof value !== "object") return value;

  if (Buffer.isBuffer(value)) {
    return sanitizeString(value.toString("utf8"), depth);
  }

  if (value instanceof Date) return value.toISOString();
  if (seen.has(value as object)) return "[CIRCULAR]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1, seen));
  }

  // Axios headers objects expose a toJSON(); use it to get plain values.
  const source =
    typeof (value as { toJSON?: unknown }).toJSON === "function"
      ? ((value as { toJSON: () => unknown }).toJSON() as Record<
          string,
          unknown
        >)
      : (value as Record<string, unknown>);

  if (typeof source !== "object" || source === null) {
    return sanitizeValue(source, depth + 1, seen);
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    out[key] = isSensitiveField(key)
      ? MASK
      : sanitizeValue(child, depth + 1, seen);
  }
  return out;
}

/**
 * Return a deep copy of `payload` with every sensitive field masked.
 * The input is never mutated.
 */
export function sanitizePayload<T = unknown>(payload: T): T {
  return sanitizeValue(payload, 0) as T;
}

/** Mask sensitive query-string parameters in a URL. */
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return url;
  const hashIndex = url.indexOf("#", qIndex);
  const query =
    hashIndex === -1 ? url.slice(qIndex + 1) : url.slice(qIndex + 1, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  return `${url.slice(0, qIndex + 1)}${sanitizeFormEncoded(query)}${hash}`;
}

export interface BoundedPayload {
  /** The payload, or a truncated JSON string when it exceeded the limit. */
  payload: unknown;
  truncated: boolean;
  /** Serialized size in bytes before truncation. */
  originalBytes: number;
}

/**
 * Cap a payload at `maxBytes` of serialized JSON. Payloads within the limit
 * are returned unchanged; larger ones become a UTF-8-safe truncated string
 * ending in {@link TRUNCATION_MARKER}.
 */
export function limitPayloadSize(
  payload: unknown,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): BoundedPayload {
  if (payload === undefined || payload === null) {
    return { payload: null, truncated: false, originalBytes: 0 };
  }

  let serialized: string;
  try {
    serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    serialized = String(payload);
  }

  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= maxBytes) {
    return { payload, truncated: false, originalBytes };
  }

  const budget = Math.max(
    0,
    maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"),
  );
  // Slice by bytes, then drop a trailing partial multi-byte character.
  let cut = Buffer.from(serialized, "utf8")
    .subarray(0, budget)
    .toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);

  return {
    payload: `${cut}${TRUNCATION_MARKER}`,
    truncated: true,
    originalBytes,
  };
}

/** Sanitize, then cap at {@link MAX_PAYLOAD_BYTES}. */
export function sanitizeAndLimit(
  payload: unknown,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): BoundedPayload {
  return limitPayloadSize(sanitizePayload(payload), maxBytes);
}
