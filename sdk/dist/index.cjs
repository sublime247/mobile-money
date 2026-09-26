/**
 * @stellar-bridge/sdk (CommonJS Build)
 * Official TypeScript & JavaScript SDK client for Mobile Money Bridge API
 */

class BridgeError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, BridgeError.prototype);
  }
}

class AuthenticationError extends BridgeError {
  constructor(message, details) {
    super(message || "Authentication failed", 401, "AUTHENTICATION_FAILED", details);
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

class ValidationError extends BridgeError {
  constructor(message, details) {
    super(message || "Validation failed", 400, "VALIDATION_ERROR", details);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

class NotFoundError extends BridgeError {
  constructor(message, details) {
    super(message || "Resource not found", 404, "NOT_FOUND", details);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

class FetchTransport {
  async request(options) {
    let fullUrl = options.url;
    if (options.params) {
      const urlObj = new URL(fullUrl);
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          urlObj.searchParams.set(key, String(value));
        }
      }
      fullUrl = urlObj.toString();
    }

    const headers = {
      Accept: "application/json",
      ...options.headers,
    };

    let bodyStr;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer = null;
    if (controller && options.timeoutMs) {
      timer = setTimeout(() => controller.abort(), options.timeoutMs);
    }

    try {
      const response = await fetch(fullUrl, {
        method: options.method,
        headers,
        body: bodyStr,
        signal: controller ? controller.signal : undefined,
      });

      if (timer) clearTimeout(timer);

      const respHeaders = {};
      response.headers.forEach((v, k) => {
        respHeaders[k.toLowerCase()] = v;
      });

      let responseData;
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        responseData = await response.json();
      } else {
        responseData = await response.text();
      }

      if (!response.ok) {
        this.handleErrorResponse(response.status, responseData);
      }

      return {
        status: response.status,
        data: responseData,
        headers: respHeaders,
      };
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err instanceof BridgeError) throw err;
      throw new BridgeError(err.message || "Network request failed", undefined, "NETWORK_ERROR", err);
    }
  }

  handleErrorResponse(status, data) {
    const message = data?.error || data?.message || `HTTP request failed with status ${status}`;
    if (status === 401) throw new AuthenticationError(message, data);
    if (status === 400) throw new ValidationError(message, data);
    if (status === 404) throw new NotFoundError(message, data);
    throw new BridgeError(message, status, "HTTP_ERROR", data);
  }
}

class StellarBridgeClient {
  constructor(config) {
    if (!config || !config.baseUrl) {
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

  setJwtToken(token) {
    this.jwtToken = token;
  }

  getJwtToken() {
    return this.jwtToken;
  }

  getAuthHeaders() {
    const headers = { ...this.defaultHeaders };
    if (this.jwtToken) {
      headers["Authorization"] = `Bearer ${this.jwtToken}`;
    }
    return headers;
  }

  async auth(params) {
    if (!params || !params.account) {
      throw new ValidationError("account (Stellar public key) is required for auth");
    }

    if (params.signedTransactionXdr) {
      const response = await this.transport.request({
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
      const response = await this.transport.request({
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

  async createCustomer(params) {
    if (!params || !params.account) {
      throw new ValidationError("account is required to create a customer");
    }

    const response = await this.transport.request({
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

  async getQuote(params) {
    if (!params || !params.sellAsset || !params.buyAsset) {
      throw new ValidationError("sellAsset and buyAsset are required to fetch a quote");
    }

    const response = await this.transport.request({
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

  async initiateDeposit(params) {
    if (!params || !params.assetCode || !params.account) {
      throw new ValidationError("assetCode and account are required to initiate deposit");
    }

    const response = await this.transport.request({
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

  async getTransactionStatus(transactionId) {
    if (!transactionId) {
      throw new ValidationError("transactionId is required");
    }

    const response = await this.transport.request({
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

  async initiateWithdrawal(params) {
    if (!params || !params.assetCode || !params.account) {
      throw new ValidationError("assetCode and account are required to initiate withdrawal");
    }

    const response = await this.transport.request({
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

module.exports = {
  BridgeError,
  AuthenticationError,
  ValidationError,
  NotFoundError,
  FetchTransport,
  StellarBridgeClient,
};
