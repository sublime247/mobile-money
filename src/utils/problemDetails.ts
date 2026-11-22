/**
 * RFC-7807 Problem Details for HTTP APIs
 * https://datatracker.ietf.org/doc/html/rfc7807
 *
 * Provides a machine-readable format for HTTP error responses, giving clients
 * a consistent, predictable structure regardless of which route errored.
 *
 * Standard fields:
 *   type      — URI identifying the problem type (dereferenceable documentation)
 *   title     — short, human-readable summary of the problem type
 *   status    — HTTP status code (mirrors the response status)
 *   detail    — human-readable explanation specific to this occurrence
 *   instance  — URI identifying the specific occurrence of this problem
 *
 * Extended fields (non-standard, included for observability):
 *   trace_id  — correlation ID linking the error to distributed traces / logs
 */

/** Base URI used to construct problem type URIs. Override via env for your docs site. */
const PROBLEM_BASE_URI =
  process.env.PROBLEM_BASE_URI ?? "https://docs.mobile-money.internal/errors";

/** Media type for RFC-7807 responses. */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Represents a fully-populated RFC-7807 Problem Details object.
 */
export interface ProblemDetails {
  /** URI reference identifying the problem type. SHOULD be dereferenceable. */
  type: string;
  /** Short, human-readable summary of the problem type. */
  title: string;
  /** HTTP status code for this occurrence. */
  status: number;
  /** Human-readable explanation specific to this occurrence. */
  detail: string;
  /** URI reference identifying this specific occurrence of the problem. */
  instance: string;
  /** Trace / correlation ID for log cross-referencing (non-standard extension). */
  trace_id?: string;
  /** Optional additional fields — open extension per RFC-7807 §3.2. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Title map  (error-code → human-readable title)
// ---------------------------------------------------------------------------

const TITLE_MAP: Record<string, string> = {
  INVALID_INPUT: "Invalid Input",
  MISSING_FIELD: "Missing Required Field",
  INVALID_PHONE_FORMAT: "Invalid Phone Number Format",
  INVALID_AMOUNT: "Invalid Amount",
  UNAUTHORIZED: "Unauthorized",
  INVALID_CREDENTIALS: "Invalid Credentials",
  TOKEN_EXPIRED: "Token Expired",
  INVALID_TOKEN: "Invalid Token",
  FORBIDDEN: "Forbidden",
  INSUFFICIENT_PERMISSIONS: "Insufficient Permissions",
  NOT_FOUND: "Not Found",
  RESOURCE_NOT_FOUND: "Resource Not Found",
  TRANSACTION_NOT_FOUND: "Transaction Not Found",
  CONFLICT: "Conflict",
  DUPLICATE_REQUEST: "Duplicate Request",
  TRANSACTION_EXISTS: "Transaction Already Exists",
  ACCOUNT_LOCKED: "Account Locked",
  UNPROCESSABLE_CONTENT: "Unprocessable Content",
  LIMIT_EXCEEDED: "Limit Exceeded",
  INSUFFICIENT_BALANCE: "Insufficient Balance",
  INSUFFICIENT_FUNDS: "Insufficient Funds",
  TRANSACTION_FAILED: "Transaction Failed",
  PROVIDER_ERROR: "Provider Error",
  RATE_LIMIT: "Rate Limit Exceeded",
  TRUSTLINE_MISSING: "Trustline Missing",
  COMPLIANCE_REQUIRED: "Compliance Required",
  INTERNAL_ERROR: "Internal Server Error",
  SERVICE_UNAVAILABLE: "Service Unavailable",
  DATABASE_ERROR: "Database Error",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an RFC-7807 Problem Details object.
 *
 * @param errorCode   - Standardised error code (e.g. `INVALID_INPUT`)
 * @param status      - HTTP status code
 * @param detail      - Occurrence-specific human-readable explanation
 * @param instance    - URI identifying this occurrence (typically the request path)
 * @param traceId     - Optional correlation ID for distributed tracing
 * @param extensions  - Optional additional fields per RFC-7807 §3.2
 *
 * @example
 * const problem = buildProblemDetails(
 *   "INVALID_INPUT",
 *   400,
 *   "The field 'amount' must be a positive number",
 *   "/api/v1/quotes",
 *   req.requestId,
 *   { invalid_fields: [{ field: "amount", reason: "must be positive" }] }
 * );
 */
export function buildProblemDetails(
  errorCode: string,
  status: number,
  detail: string,
  instance: string,
  traceId?: string,
  extensions?: Record<string, unknown>,
): ProblemDetails {
  const slug = errorCode.toLowerCase().replace(/_/g, "-");
  const problem: ProblemDetails = {
    type: `${PROBLEM_BASE_URI}/${slug}`,
    title: TITLE_MAP[errorCode] ?? toTitleCase(errorCode),
    status,
    detail,
    instance,
    ...(traceId !== undefined && traceId !== "" ? { trace_id: traceId } : {}),
    ...extensions,
  };
  return problem;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function toTitleCase(errorCode: string): string {
  return errorCode
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
