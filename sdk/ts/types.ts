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
