/**
 * @stellar-bridge/sdk TypeScript Declarations
 */

export interface ClientConfig {
  baseUrl: string;
  jwtToken?: string;
  timeoutMs?: number;
  transport?: "fetch" | "axios";
  headers?: Record<string, string>;
}

export interface AuthParams {
  account: string;
  homeDomain?: string;
  signedTransactionXdr?: string;
}

export interface AuthResult {
  token?: string;
  challengeXdr?: string;
  networkPassphrase?: string;
}

export interface CustomerParams {
  account: string;
  firstName?: string;
  lastName?: string;
  emailAddress?: string;
  phoneNumber?: string;
  idType?: string;
  idNumber?: string;
  idCountryCode?: string;
  address?: string;
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
  countryCode?: string;
  account?: string;
}

export interface QuoteResult {
  id: string;
  price: string;
  totalPrice?: string;
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
  assetCode: string;
  account: string;
  amount?: string;
  quoteId?: string;
  walletName?: string;
  walletUrl?: string;
  lang?: string;
  claimableBalanceSupported?: boolean;
}

export interface DepositResult {
  type: "interactive_customer_info_needed";
  url: string;
  id: string;
  status?: string;
}

export interface TransactionStatusResult {
  id: string;
  status: string;
  statusEta?: number;
  amountIn?: string;
  amountOut?: string;
  amountFee?: string;
  startedAt?: string;
  completedAt?: string;
  stellarTransactionId?: string;
  externalTransactionId?: string;
  message?: string;
}

export interface WithdrawalParams {
  assetCode: string;
  account: string;
  amount?: string;
  quoteId?: string;
  dest?: string;
  destExtra?: string;
}

export interface WithdrawalResult {
  type: "interactive_customer_info_needed";
  url: string;
  id: string;
  status?: string;
}

export interface HttpRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export interface Transport {
  request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>>;
}

export declare class FetchTransport implements Transport {
  request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>>;
}

export declare class AxiosTransport implements Transport {
  request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>>;
}

export declare class BridgeError extends Error {
  statusCode?: number;
  response?: unknown;
  constructor(message: string, statusCode?: number, response?: unknown);
}

export declare class AuthenticationError extends BridgeError {
  constructor(message?: string, response?: unknown);
}

export declare class ValidationError extends BridgeError {
  constructor(message?: string, response?: unknown);
}

export declare class NotFoundError extends BridgeError {
  constructor(message?: string, response?: unknown);
}

export declare class StellarBridgeClient {
  constructor(config: ClientConfig);
  setJwtToken(token: string): void;
  getJwtToken(): string | undefined;
  auth(params: AuthParams): Promise<AuthResult>;
  createCustomer(params: CustomerParams): Promise<CustomerResult>;
  getQuote(params: QuoteParams): Promise<QuoteResult>;
  initiateDeposit(params: DepositParams): Promise<DepositResult>;
  initiateWithdrawal(params: WithdrawalParams): Promise<WithdrawalResult>;
  getTransactionStatus(transactionId: string): Promise<TransactionStatusResult>;
}
