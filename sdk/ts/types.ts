/**
 * Core type definitions for @stellar-bridge/sdk
 */

export interface ClientConfig {
  /** Base URL for the Mobile Money Bridge API (e.g. "https://api.bridge.stellarwave.io") */
  baseUrl: string;
  /** Optional JWT token to authorize subsequent requests */
  jwtToken?: string;
  /** Optional HTTP request timeout in milliseconds (default: 15000) */
  timeoutMs?: number;
  /** Transport adapter: "fetch" or "axios" (default: "fetch" if available, otherwise "axios") */
  transport?: "fetch" | "axios";
  /** Optional custom headers */
  headers?: Record<string, string>;
  /** Automatic retry behavior for idempotent requests (default: enabled, 3 retries) */
  retry?: RetryOptions;
}

export interface RetryOptions {
  /** Set to false to disable automatic retries entirely (default: true) */
  enabled?: boolean;
  /** Maximum number of retry attempts after the initial request (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 200) */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds between retries (default: 5000) */
  maxDelayMs?: number;
}

export interface AuthParams {
  /** Stellar public key of the client account (G...) */
  account: string;
  /** Client's home domain (e.g. "stellarwave.io") */
  homeDomain?: string;
  /** Optional signed challenge transaction XDR. If omitted, challenge is requested */
  signedTransactionXdr?: string;
}

export interface AuthResult {
  /** JWT token if authentication was completed */
  token?: string;
  /** Challenge transaction XDR if awaiting signature */
  challengeXdr?: string;
  /** Network passphrase for Stellar testnet/public */
  networkPassphrase?: string;
}

export interface CustomerParams {
  /** Stellar public key (G...) */
  account: string;
  firstName?: string;
  lastName?: string;
  emailAddress?: string;
  mobileNumber?: string;
  type?: string;
}

export interface CustomerResult {
  id: string;
  status: "ACCEPTED" | "PROCESSING" | "NEEDS_INFO" | "REJECTED";
  fields?: Record<string, unknown>;
  message?: string;
}

export interface QuoteParams {
  sellAsset: string;
  buyAsset: string;
  sellAmount?: string;
  buyAmount?: string;
  context?: "sep24" | "sep31" | "sep6";
  expireAfter?: string;
}

export interface QuoteResult {
  id: string;
  price: string;
  totalPrice: string;
  sellAsset: string;
  sellAmount: string;
  buyAsset: string;
  buyAmount: string;
  expiresAt: string;
  fee?: {
    total: string;
    asset: string;
  };
}

export interface DepositParams {
  /** Asset code being deposited (e.g. "USDC", "XLM") */
  assetCode: string;
  /** User Stellar public key (G...) */
  account: string;
  /** Amount to deposit */
  amount?: string;
  /** Optional mobile phone number for direct push */
  phoneNumber?: string;
  /** Provider key (e.g. "mtn", "orange", "mpesa", "wave") */
  provider?: string;
  /** Client domain */
  clientDomain?: string;
}

export interface DepositResult {
  /** Interactive SEP-24 webview URL */
  url: string;
  /** Transaction tracking ID */
  id: string;
  /** Transaction status */
  status: string;
}

export interface TransactionStatusResult {
  id: string;
  status: string;
  amountIn?: string;
  amountOut?: string;
  amountFee?: string;
  assetIn?: string;
  assetOut?: string;
  startedAt?: string;
  completedAt?: string;
  message?: string;
}

export interface ListTransactionsParams {
  /** Items requested per page (server clamps to 1-100, default: 20) */
  limit?: number;
  /** Stop after yielding this many items in total (default: no cap) */
  maxItems?: number;
  /** Start iterating from this cursor instead of the first page */
  cursor?: string;
  /** ISO 8601 date (YYYY-MM-DD), inclusive lower bound */
  startDate?: string;
  /** ISO 8601 date (YYYY-MM-DD), inclusive upper bound */
  endDate?: string;
  minAmount?: number;
  maxAmount?: number;
  provider?: string;
  /** Tags to filter by (sent comma-separated) */
  tags?: string[];
}

export interface TransactionListItem {
  id: string;
  [key: string]: unknown;
}

export interface TransactionListPagination {
  limit?: number;
  next_cursor?: string | null;
  next_token?: string | null;
  has_next?: boolean;
  hasMore?: boolean;
  offset?: number;
}

export interface TransactionListResponse {
  data: TransactionListItem[];
  pagination?: TransactionListPagination;
}
