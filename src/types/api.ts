import { Transaction, TransactionStatus } from "../models/transaction";
import { KYCLevel } from "../config/limits";

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

export interface TransactionResponse {
  transactionId: string;
  referenceNumber: string;
  status: TransactionStatus;
  jobId: string | undefined;
}

export interface TransactionDetailResponse extends Transaction {
  jobProgress: number | null;
  reason?: string;
}

export interface CancelTransactionResponse {
  message: string;
  transaction: Transaction;
}

// ---------------------------------------------------------------------------
// Phone Number Search
// ---------------------------------------------------------------------------

export interface PhoneSearchPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PhoneSearchResponse {
  success: boolean;
  pagination: PhoneSearchPagination;
  data: Transaction[];
}

// ---------------------------------------------------------------------------
// Metadata Search
// ---------------------------------------------------------------------------

export interface MetadataSearchResponse {
  data: Transaction[];
  total: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Standardized error response format for all API endpoints.
 * 
 * All errors returned by the API follow this consistent structure, enabling
 * clients to handle errors programmatically while providing users with
 * messages in their preferred language.
 * 
 * **Fields:**
 * - `code`: Standard error code for programmatic error handling
 *   - Examples: INVALID_INPUT, UNAUTHORIZED, NOT_FOUND, LIMIT_EXCEEDED
 *   - See ERROR_CODES constant for full list
 * - `message`: Localized human-readable error message based on Accept-Language header
 *   - Automatically translated to: English, French, Spanish, or Portuguese
 *   - Falls back to English if language not supported
 * - `message_en`: Always English error message as guaranteed fallback
 *   - Useful when client cannot use localized message
 *   - Always present in all error responses
 * - `timestamp`: ISO 8601 formatted timestamp of when error occurred
 *   - Format: "2026-03-27T10:30:00.000Z"
 * - `requestId`: Optional unique identifier for this request
 *   - Useful for tracing errors in logs and monitoring systems
 *   - Present if request ID middleware is enabled
 * - `details`: Optional error context object (development mode only)
 *   - Additional information specific to the error type
 *   - Examples: { field: "phoneNumber" }, { balance: 100, requested: 500 }
 *   - Never included in production for security/privacy reasons
 * 
 * **Client Usage:**
 * 
 * ```typescript
 * // Programmatic error handling by code
 * try {
 *   const response = await fetch('/api/transfer', options);
 * } catch (error) {
 *   const errorResponse: ErrorResponse = error.response.data;
 *   
 *   switch (errorResponse.code) {
 *     case 'LIMIT_EXCEEDED':
 *       showLimitDialog(errorResponse.details);
 *       break;
 *     case 'INSUFFICIENT_BALANCE':
 *       showBalanceWarning(errorResponse.details?.balance);
 *       break;
 *     default:
 *       showError(errorResponse.message); // Localized message
 *   }
 * }
 * ```
 * 
 * **Examples:**
 * 
 * Validation error (French client):
 * ```json
 * {
 *   "code": "INVALID_PHONE_FORMAT",
 *   "message": "Le format du numéro de téléphone est invalide",
 *   "message_en": "Phone number format is invalid",
 *   "timestamp": "2026-03-27T10:30:00.000Z",
 *   "requestId": "req-123-abc",
 *   "details": { "received": "+invalid" }
 * }
 * ```
 * 
 * Authentication error (English client):
 * ```json
 * {
 *   "code": "UNAUTHORIZED",
 *   "message": "Unauthorized access",
 *   "message_en": "Unauthorized access",
 *   "timestamp": "2026-03-27T10:31:00.000Z",
 *   "requestId": "req-456-def"
 * }
 * ```
 * 
 * Business logic error (Portuguese client):
 * ```json
 * {
 *   "code": "LIMIT_EXCEEDED",
 *   "message": "Limite de transações diárias excedido",
 *   "message_en": "Daily transaction limit exceeded",
 *   "timestamp": "2026-03-27T10:32:00.000Z",
 *   "requestId": "req-789-ghi",
 *   "details": { "dailyLimit": 5000, "currentTotal": 5000 }
 * }
 * ```
 * 
 * @interface ErrorResponse
 * @property {string} code - Standard error code for programmatic handling
 * @property {string} message - Localized error message (based on Accept-Language header)
 * @property {string} message_en - English error message (always included as fallback)
 * @property {string} timestamp - ISO 8601 timestamp of error occurrence
 * @property {string} [requestId] - Optional unique request identifier for tracing
 * @property {Record<string, unknown>} [details] - Optional context data (development only)
 */
export interface ErrorResponse {
  code: string;
  message: string;
  message_en: string;
  timestamp: string;
  requestId?: string;
  details?: Record<string, unknown> | LimitExceededDetails;
}

export interface LimitExceededDetails {
  kycLevel: KYCLevel;
  dailyLimit: number;
  currentDailyTotal: number;
  remainingLimit: number;
  message?: string;
  upgradeAvailable?: boolean;
}

export interface LimitExceededErrorResponse extends ErrorResponse {
  details: LimitExceededDetails;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthCheckResponse {
  status: "ok";
  timestamp: string;
}

export interface ReadinessCheckResponse {
  status: "ready" | "not ready";
  checks: Record<string, string>;
  timestamp: string;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  paused: boolean;
}

export interface QueueHealthResponse {
  status: "healthy" | "degraded";
  timestamp: string;
  queue: string;
  stats: QueueStats;
}

export interface QueueActionResponse {
  success: boolean;
  message: string;
}