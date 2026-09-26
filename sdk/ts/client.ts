/**
 * Official Stellar Mobile Money Bridge Client
 */

import type {
  ClientConfig,
  AuthParams,
  AuthResult,
  CustomerParams,
  CustomerResult,
  QuoteParams,
  QuoteResult,
  DepositParams,
  DepositResult,
  TransactionStatusResult,
} from "./types.ts";
import { type Transport, FetchTransport } from "./transport.ts";
import { AuthenticationError, ValidationError } from "./errors.ts";

export class StellarBridgeClient {
  private readonly baseUrl: string;
  private jwtToken?: string;
  private readonly timeoutMs: number;
  private readonly transport: Transport;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: ClientConfig) {
    if (!config.baseUrl) {
      throw new ValidationError("baseUrl is required to initialize StellarBridgeClient");
    }
    let sanitizedUrl = config.baseUrl;
    while (sanitizedUrl.endsWith("/")) {
      sanitizedUrl = sanitizedUrl.slice(0, -1);
    }
    this.baseUrl = sanitizedUrl;
    this.jwtToken = config.jwtToken;
    this.timeoutMs = config.timeoutMs || 15000;
    this.transport = new FetchTransport();
    this.defaultHeaders = config.headers || {};
  }

  /**
   * Set or update active JWT authorization token
   */
  public setJwtToken(token: string): void {
    this.jwtToken = token;
  }

  /**
   * Get active JWT authorization token
   */
  public getJwtToken(): string | undefined {
    return this.jwtToken;
  }

  private getAuthHeaders(): Record<string, string> {
    const headers = { ...this.defaultHeaders };
    if (this.jwtToken) {
      headers["Authorization"] = `Bearer ${this.jwtToken}`;
    }
    return headers;
  }

  /**
   * SEP-10 Stellar Authentication:
   * 1. If signedTransactionXdr is not provided: requests a challenge transaction XDR.
   * 2. If signedTransactionXdr is provided: exchanges the signed transaction for a JWT token.
   */
  public async auth(params: AuthParams): Promise<AuthResult> {
    if (!params.account) {
      throw new ValidationError("account (Stellar public key) is required for auth");
    }

    if (params.signedTransactionXdr) {
      // Step 2: Submit signed challenge to receive JWT
      const response = await this.transport.request<{ token: string }>({
        method: "POST",
        url: `${this.baseUrl}/sep10/auth`,
        headers: this.defaultHeaders,
        body: { transaction: params.signedTransactionXdr },
        timeoutMs: this.timeoutMs,
      });

      if (response.data.token) {
        this.jwtToken = response.data.token;
      }

      return {
        token: response.data.token,
      };
    } else {
      // Step 1: Fetch challenge transaction
      const response = await this.transport.request<{ transaction: string; network_passphrase?: string }>({
        method: "GET",
        url: `${this.baseUrl}/sep10/auth`,
        headers: this.defaultHeaders,
        params: {
          account: params.account,
          home_domain: params.homeDomain,
        },
        timeoutMs: this.timeoutMs,
      });

      return {
        challengeXdr: response.data.transaction,
        networkPassphrase: response.data.network_passphrase,
      };
    }
  }

  /**
   * SEP-12 KYC: Create or update customer KYC record
   */
  public async createCustomer(params: CustomerParams): Promise<CustomerResult> {
    if (!params.account) {
      throw new ValidationError("account is required to create a customer");
    }

    const response = await this.transport.request<{ id: string; status: "ACCEPTED" | "PROCESSING" | "NEEDS_INFO" | "REJECTED"; fields?: Record<string, unknown>; message?: string }>({
      method: "PUT",
      url: `${this.baseUrl}/sep12/customer`,
      headers: this.getAuthHeaders(),
      body: {
        account: params.account,
        first_name: params.firstName,
        last_name: params.lastName,
        email_address: params.emailAddress,
        mobile_number: params.mobileNumber,
        type: params.type,
      },
      timeoutMs: this.timeoutMs,
    });

    return {
      id: response.data.id,
      status: response.data.status,
      fields: response.data.fields,
      message: response.data.message,
    };
  }

  /**
   * SEP-38: Request firm exchange rate quote
   */
  public async getQuote(params: QuoteParams): Promise<QuoteResult> {
    if (!params.sellAsset || !params.buyAsset) {
      throw new ValidationError("sellAsset and buyAsset are required to fetch a quote");
    }

    const response = await this.transport.request<{
      id: string;
      price: string;
      total_price: string;
      sell_asset: string;
      sell_amount: string;
      buy_asset: string;
      buy_amount: string;
      expires_at: string;
      fee?: { total: string; asset: string };
    }>({
      method: "POST",
      url: `${this.baseUrl}/sep38/quote`,
      headers: this.getAuthHeaders(),
      body: {
        context: params.context || "sep24",
        sell_asset: params.sellAsset,
        buy_asset: params.buyAsset,
        sell_amount: params.sellAmount,
        buy_amount: params.buyAmount,
        expire_after: params.expireAfter,
      },
      timeoutMs: this.timeoutMs,
    });

    const d = response.data;
    return {
      id: d.id,
      price: d.price,
      totalPrice: d.total_price || d.price,
      sellAsset: d.sell_asset,
      sellAmount: d.sell_amount,
      buyAsset: d.buy_asset,
      buyAmount: d.buy_amount,
      expiresAt: d.expires_at,
      fee: d.fee,
    };
  }

  /**
   * SEP-24: Initiate interactive deposit flow
   */
  public async initiateDeposit(params: DepositParams): Promise<DepositResult> {
    if (!params.assetCode || !params.account) {
      throw new ValidationError("assetCode and account are required to initiate deposit");
    }

    const response = await this.transport.request<{ url: string; id: string; status?: string }>({
      method: "POST",
      url: `${this.baseUrl}/sep24/transactions/deposit/interactive`,
      headers: this.getAuthHeaders(),
      body: {
        asset_code: params.assetCode,
        account: params.account,
        amount: params.amount,
        phone_number: params.phoneNumber,
        provider: params.provider,
        client_domain: params.clientDomain,
      },
      timeoutMs: this.timeoutMs,
    });

    return {
      url: response.data.url,
      id: response.data.id,
      status: response.data.status || "pending_user_transfer_start",
    };
  }

  /**
   * SEP-24: Query transaction status by transaction ID
   */
  public async getTransactionStatus(transactionId: string): Promise<TransactionStatusResult> {
    if (!transactionId) {
      throw new ValidationError("transactionId is required");
    }

    const response = await this.transport.request<{ transaction: any }>({
      method: "GET",
      url: `${this.baseUrl}/sep24/transaction`,
      headers: this.getAuthHeaders(),
      params: { id: transactionId },
      timeoutMs: this.timeoutMs,
    });

    const tx = response.data.transaction || response.data;
    return {
      id: tx.id || transactionId,
      status: tx.status,
      amountIn: tx.amount_in,
      amountOut: tx.amount_out,
      amountFee: tx.amount_fee,
      assetIn: tx.asset_in,
      assetOut: tx.asset_out,
      startedAt: tx.started_at,
      completedAt: tx.completed_at,
      message: tx.message,
    };
  }

  /**
   * SEP-24: Initiate interactive withdrawal flow
   */
  public async initiateWithdrawal(params: DepositParams): Promise<DepositResult> {
    if (!params.assetCode || !params.account) {
      throw new ValidationError("assetCode and account are required to initiate withdrawal");
    }

    const response = await this.transport.request<{ url: string; id: string; status?: string }>({
      method: "POST",
      url: `${this.baseUrl}/sep24/transactions/withdraw/interactive`,
      headers: this.getAuthHeaders(),
      body: {
        asset_code: params.assetCode,
        account: params.account,
        amount: params.amount,
        phone_number: params.phoneNumber,
        provider: params.provider,
        client_domain: params.clientDomain,
      },
      timeoutMs: this.timeoutMs,
    });

    return {
      url: response.data.url,
      id: response.data.id,
      status: response.data.status || "pending_user_transfer_start",
    };
  }
}
