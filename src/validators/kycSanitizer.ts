/**
 * KYC input sanitization layer (issue #1973).
 *
 * Sanitizes all string fields submitted to SEP-12 `PUT /customer` and the
 * KYC applicant endpoints (first name, last name, address, ID numbers, ...)
 * to prevent XSS, SQL injection and command injection.
 *
 * Strategy:
 * - Strings with HTML tags or SQL control characters are *rejected*
 *   (per acceptance criteria) rather than silently rewritten, so attackers
 *   cannot rely on lenient normalization.
 * - Remaining strings are HTML-escaped and stripped of control characters
 *   before being persisted.
 *
 * Acceptance criteria mapping:
 * - [x] Sanitize input using DOMPurify / validator.js style routines —
 *       implemented with the server-side `xss` sanitizer (already a
 *       dependency, DOMPurify requires a DOM) plus validator-style
 *       allow-list checks for identifier fields.
 * - [x] Reject payloads containing HTML tags or SQL control characters.
 * - [x] Automated tests: see `src/validators/__tests__/kycSanitizer.test.ts`.
 */

import xssPackage, { FilterXSS } from "xss";

const xssFilter = new (
  (xssPackage as unknown as { FilterXSS: typeof FilterXSS }).FilterXSS ||
  FilterXSS
)({
  // Strip every tag: KYC fields are plain-text data, never markup.
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style"],
  // Escape remaining angle brackets instead of dropping them. Quotes and
  // ampersands are intentionally preserved so legitimate human data such as
  // "O'Brien" or "AT&T" survives sanitization untouched.
  escapeHtml: (raw: string) =>
    raw.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
});

/** SQL/SQLi control tokens and comment markers. */
const SQL_INJECTION_PATTERNS: RegExp[] = [
  /(\b(OR|AND)\b\s+\d+\s*=\s*\d+)/i, // ' OR 1=1
  /(\b(UNION)\b[\s\S]{0,40}?\bSELECT\b)/i, // UNION SELECT
  /(\bSELECT\b[\s\S]+?\bFROM\b)/i, // SELECT ... FROM
  /(\bINSERT\b\s+\bINTO\b)/i,
  /(\bUPDATE\b\s+\b\S+\s+\bSET\b)/i,
  /(\bDELETE\b\s+\bFROM\b)/i,
  /(\bDROP\b\s+(TABLE|DATABASE|SCHEMA)\b)/i,
  /(\bALTER\b\s+TABLE\b)/i,
  /(\bTRUNCATE\b\s+TABLE?\b)/i,
  /(\bEXEC(UTE)?\b\s*\()/i,
  /(\bMERGE\b\s+\bINTO\b)/i,
  /(--|#|\/\*|\*\/)/, // SQL comment markers
  /(;\s*(DROP|DELETE|UPDATE|INSERT|SELECT|EXEC)\b)/i, // stacked queries
];

/** Shell/command injection metacharacters and sequences. */
const COMMAND_INJECTION_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F`$\\|;&<>\n\r]/;

/**
 * Maximum accepted length for a single KYC field before rejection.
 * Bounds every downstream scan so no regex can run on unbounded input.
 */
const MAX_FIELD_LENGTH = 5000;

export class SanitizationError extends Error {
  field: string;
  reason: string;

  constructor(field: string, reason: string) {
    super(`Field "${field}" ${reason}`);
    this.name = "SanitizationError";
    this.field = field;
    this.reason = reason;
  }
}

/**
 * True when the value contains HTML markup.
 *
 * Implemented as a linear-time scan (indexOf + single-character class test)
 * rather than a tag-matching regex: tag regexes need adjacent unbounded
 * quantifiers (`<\\s*\\/?\\s*...`) which backtrack polynomially on hostile
 * inputs such as "<A A A A ..." (cf. CodeQL js/polynomial-redos).
 */
export function containsHtmlTag(value: string): boolean {
  const idx = value.indexOf("<");
  if (idx === -1 || idx === value.length - 1) {
    return false;
  }
  const next = value[idx + 1];
  // Any "<" immediately followed by a tag-ish character opens markup:
  // letters (tags), "/" (closing), "!" (comments/doctype), "?" (PI).
  return /[a-zA-Z!/?]/.test(next);
}

/** True when the value matches known SQL injection patterns. */
export function containsSqlInjection(value: string): boolean {
  return SQL_INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

/** True when the value contains shell metacharacters or control bytes. */
export function containsCommandInjection(value: string): boolean {
  return COMMAND_INJECTION_PATTERN.test(value);
}

/**
 * Checks a raw string for malicious content.
 * @returns A list of detected threat categories (empty when clean).
 */
export function detectThreats(value: string): string[] {
  const threats: string[] = [];
  if (containsHtmlTag(value)) threats.push("html_tag");
  if (containsSqlInjection(value)) threats.push("sql_injection");
  if (containsCommandInjection(value)) threats.push("command_injection");
  return threats;
}

/**
 * Sanitizes a single string value:
 * 1. Rejects HTML tags, SQL injection, and command injection payloads.
 * 2. HTML-escapes the surviving value and removes control characters.
 *
 * @throws SanitizationError when the payload contains dangerous content.
 */
export function sanitizeKycString(field: string, value: string): string {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length > MAX_FIELD_LENGTH) {
    throw new SanitizationError(
      field,
      `was rejected: exceeds maximum length of ${MAX_FIELD_LENGTH} characters`,
    );
  }

  const threats = detectThreats(value);
  if (threats.length > 0) {
    throw new SanitizationError(
      field,
      `was rejected: contains malicious content (${threats.join(", ")})`,
    );
  }

  // Normalize unicode tricks (e.g. full-width characters used to bypass filters).
  const normalized = value.normalize("NFKC");
  // Remove any remaining control characters (non-printable bytes).
  const stripped = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  return xssFilter.process(stripped).trim();
}

/**
 * Recursively sanitizes every string in a payload (objects, arrays,
 * nested structures). Non-string scalars pass through untouched.
 *
 * @throws SanitizationError when any string contains malicious content.
 */
export function sanitizeKycPayload<T>(payload: T, prefix = ""): T {
  if (typeof payload === "string") {
    return sanitizeKycString(prefix || "value", payload) as unknown as T;
  }
  if (Array.isArray(payload)) {
    return payload.map((item, index) =>
      sanitizeKycPayload(item, `${prefix}[${index}]`),
    ) as unknown as T;
  }
  if (payload && typeof payload === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      out[key] = sanitizeKycPayload(value, prefix ? `${prefix}.${key}` : key);
    }
    return out as T;
  }
  return payload;
}

/**
 * Express middleware: sanitizes `req.body` for KYC endpoints.
 * Rejects the request with 400 when any field contains malicious content.
 */
export function kycSanitizeBody(
  req: { body: unknown },
  res: {
    status: (code: number) => {
      json: (body: unknown) => unknown;
    };
  },
  next: (err?: unknown) => void,
): void {
  try {
    req.body = sanitizeKycPayload(req.body);
    next();
  } catch (error) {
    if (error instanceof SanitizationError) {
      res.status(400).json({
        error: "invalid_input",
        message: error.message,
        field: error.field,
      });
      return;
    }
    next(error);
  }
}
