import axios, {
  AxiosInstance,
  AxiosError,
  AxiosRequestConfig,
  AxiosResponse,
} from "axios";

import logger from "../../../utils/logger";
import { maskPII } from "../../../utils/masking";
import { formatPhoneForProvider } from "../../../utils/phoneUtils";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

type AirtelMode = "direct" | "web" | "proxy";

interface AirtelResponse {
  data?: {
    transaction?: {
      status: string;
      id: string;
    };
  };
  status?: {
    success: boolean;
    code: string;
  };
}

interface AirtelBalanceResponse {
  data?: {
    balance?: string | number;
    availableBalance?: string | number;
    currency?: string;
  };
  balance?: string | number;
  availableBalance?: string | number;
  currency?: string;
}

interface StoredCookie {
  value: string;
  expiresAt?: number;
}

interface AirtelSessionState {
  cookies: Record<string, StoredCookie>;
  csrfToken?: string;
  expiresAt: number;
  authenticatedAt: number;
}

interface AirtelProviderConfig {
  mode?: AirtelMode;
  webBaseUrl: string;
  directBaseUrl: string;
  loginPath: string;
  refreshPath: string;
  paymentPath: string;
  payoutPath: string;
  statusPath: string;
  username: string;
  password: string;
  usernameField: string;
  passwordField: string;
  csrfField: string;
  apiKey: string;
  apiSecret: string;
  country: string;
  currency: string;
  sessionStorePath?: string;
  sessionTtlMs: number;
  refreshSkewMs: number;
  requestTimeoutMs: number;
  maxAttempts: number;
  proxyBaseUrl?: string;
  proxySecret?: string;
}

interface AirtelHttpClient extends Partial<
  Pick<AxiosInstance, "request" | "get" | "post">
> {}

interface AirtelProviderOptions extends Partial<AirtelProviderConfig> {
  baseUrl?: string;
  httpClient?: AirtelHttpClient;
  proxyHttpClient?: AirtelHttpClient;
  directHttpClient?: AirtelHttpClient;
  clock?: () => number;
}

const DEFAULT_SESSION_TTL_MS = 20 * 60 * 1000;
const DEFAULT_REFRESH_SKEW_MS = 60 * 1000;

// ============================================================================
// AIRTEL SERVICE
// ============================================================================

export class AirtelService {
  private client: AirtelHttpClient;
  private proxyClient?: AirtelHttpClient;
  private directClient: AirtelHttpClient;
  private config: AirtelProviderConfig;
  private mode: AirtelMode;
  private token: string | null = null;
  private tokenExpiry: number = 0;
  private session: AirtelSessionState | null = null;
  private sessionPromise: Promise<AirtelSessionState> | null = null;
  private readonly clock: () => number;

  constructor(options: AirtelProviderOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.config = this.buildConfig(options);
    this.mode = this.resolveMode();

    this.client =
      options.httpClient ??
      axios.create({
        baseURL: this.config.webBaseUrl,
        timeout: this.config.requestTimeoutMs,
        maxRedirects: 0,
        validateStatus: () => true,
      });

    this.directClient =
      options.directHttpClient ??
      axios.create({
        baseURL: this.config.directBaseUrl,
        timeout: this.config.requestTimeoutMs,
        validateStatus: () => true,
      });

    if (this.config.proxyBaseUrl) {
      this.proxyClient =
        options.proxyHttpClient ??
        axios.create({
          baseURL: this.config.proxyBaseUrl,
          timeout: this.config.requestTimeoutMs,
          validateStatus: () => true,
        });
    }

    logger.info({ mode: this.mode }, "AirtelService initialized");
  }

  // =========================================================================
  // CONFIGURATION
  // =========================================================================

  private buildConfig(options: AirtelProviderOptions): AirtelProviderConfig {
    return {
      mode: options.mode ?? (process.env.AIRTEL_MODE as AirtelMode | undefined),
      webBaseUrl:
        options.webBaseUrl ??
        options.baseUrl ??
        process.env.AIRTEL_WEB_BASE_URL ??
        process.env.AIRTEL_BASE_URL ??
        "",
      directBaseUrl:
        options.directBaseUrl ??
        options.baseUrl ??
        process.env.AIRTEL_DIRECT_BASE_URL ??
        "https://openapi.airtel.africa",
      sandboxBaseUrl: options.sandboxBaseUrl ?? options.baseUrl ?? process.env.AIRTEL_SANDBOX_BASE_URL ?? "",
      loginPath: options.loginPath ?? process.env.AIRTEL_LOGIN_PATH ?? "/login",
      refreshPath:
        options.refreshPath ??
        process.env.AIRTEL_REFRESH_PATH ??
        "/session/refresh",
      paymentPath:
        options.paymentPath ??
        process.env.AIRTEL_PAYMENT_PATH ??
        "/merchant/v1/payments/",
      payoutPath:
        options.payoutPath ??
        process.env.AIRTEL_PAYOUT_PATH ??
        "/standard/v1/disbursements/",
      statusPath:
        options.statusPath ??
        process.env.AIRTEL_STATUS_PATH ??
        "/standard/v1/payments/:reference",
      username: options.username ?? process.env.AIRTEL_USERNAME ?? "",
      password: options.password ?? process.env.AIRTEL_PASSWORD ?? "",
      usernameField:
        options.usernameField ??
        process.env.AIRTEL_USERNAME_FIELD ??
        "username",
      passwordField:
        options.passwordField ??
        process.env.AIRTEL_PASSWORD_FIELD ??
        "password",
      csrfField: options.csrfField ?? process.env.AIRTEL_CSRF_FIELD ?? "_csrf",
      apiKey: options.apiKey ?? process.env.AIRTEL_API_KEY ?? "",
      apiSecret: options.apiSecret ?? process.env.AIRTEL_API_SECRET ?? "",
      country: options.country ?? process.env.AIRTEL_COUNTRY ?? "NG",
      currency: options.currency ?? process.env.AIRTEL_CURRENCY ?? "NGN",
      sessionStorePath:
        options.sessionStorePath ?? process.env.AIRTEL_SESSION_STORE_PATH,
      sessionTtlMs: Number(
        options.sessionTtlMs ??
          process.env.AIRTEL_SESSION_TTL_MS ??
          DEFAULT_SESSION_TTL_MS,
      ),
      refreshSkewMs: Number(
        options.refreshSkewMs ??
          process.env.AIRTEL_REFRESH_SKEW_MS ??
          DEFAULT_REFRESH_SKEW_MS,
      ),
      requestTimeoutMs: Number(
        options.requestTimeoutMs ?? process.env.REQUEST_TIMEOUT_MS ?? 30000,
      ),
      maxAttempts: Number(
        options.maxAttempts ?? process.env.AIRTEL_MAX_ATTEMPTS ?? 3,
      ),
      proxyBaseUrl: options.proxyBaseUrl ?? process.env.AIRTEL_PROXY_URL,
      proxySecret: options.proxySecret ?? process.env.AIRTEL_PROXY_SECRET,
    };
  }

  private resolveMode(): AirtelMode {
    if (this.config.proxyBaseUrl) {
      return "proxy";
    }

    if (this.config.mode === "direct" || this.config.mode === "web") {
      return this.config.mode;
    }

    if (
      this.config.webBaseUrl &&
      (this.config.username || this.config.sessionStorePath)
    ) {
      return "web";
    }

    return "direct";
  }

  // =========================================================================
  // PUBLIC METHODS
  // =========================================================================

  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(
      maskPII({ phoneNumber, amount, mode: this.mode }),
      "Airtel: Requesting payment",
    );
    const startTime = Date.now();

    try {
      const reference = `AIRTEL-${Date.now()}`;

      const response =
        this.mode === "proxy"
          ? await this.executeViaProxy(
              "payment",
              phoneNumber,
              amount,
              reference,
            )
          : this.mode === "web"
            ? await this.executeViaWebSession(
                "payment",
                phoneNumber,
                amount,
                reference,
              )
            : await this.executeViaDirect(
                "payment",
                phoneNumber,
                amount,
                reference,
              );

      const duration = Date.now() - startTime;
      log.info(
        maskPII({ duration, success: response.success }),
        "Airtel: Payment request completed",
      );

      return {
        success: response.success ?? false,
        data: response.data,
        providerResponseTimeMs: duration,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      log.error(
        maskPII({ duration, error: error.message }),
        "Airtel: Payment request failed",
      );
      return {
        success: false,
        error,
        providerResponseTimeMs: duration,
      };
    }
  }

  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    const log = requestId ? logger.child({ requestId }) : logger;
    const formattedPhoneNumber = formatPhoneForProvider(phoneNumber, "airtel");
    log.info(
      maskPII({ phoneNumber: formattedPhoneNumber, amount, mode: this.mode }),
      "Airtel: Sending payout",
    );
    const startTime = Date.now();

    try {
      const reference = `AIRTEL-PAYOUT-${Date.now()}`;

      const response =
        this.mode === "proxy"
          ? await this.executeViaProxy("payout", formattedPhoneNumber, amount, reference)
          : this.mode === "web"
            ? await this.executeViaWebSession(
                "payout",
                formattedPhoneNumber,
                amount,
                reference,
              )
            : await this.executeViaDirect(
                "payout",
                formattedPhoneNumber,
                amount,
                reference,
              );

      const duration = Date.now() - startTime;
      log.info(
        maskPII({ duration, success: response.success }),
        "Airtel: Payout completed",
      );

      return {
        success: response.success ?? false,
        data: response.data,
        providerResponseTimeMs: duration,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      log.error(
        maskPII({ duration, error: error.message }),
        "Airtel: Payout failed",
      );
      return {
        success: false,
        error,
        providerResponseTimeMs: duration,
      };
    }
  }

  /**
   * =========================
   * REQUEST PAYMENT (COLLECTION)
   * =========================
   */
  async getTransactionStatus(
    reference: string,
  ): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
    try {
      const result = await this.checkStatus(reference);
      if (!result.success) return { status: "unknown" };
      const txStatus = String(
        (result.data as AirtelResponse)?.data?.transaction?.status ?? "",
      ).toUpperCase();
      // Airtel status codes: TS = success, TF = failed, TP = pending
      if (txStatus === "TS") return { status: "completed" };
      if (txStatus === "TF") return { status: "failed" };
      if (txStatus === "TP") return { status: "pending" };
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  async checkStatus(reference: string) {
    return this.mode === "proxy"
      ? this.checkStatusViaProxy(reference)
      : this.mode === "web"
        ? this.checkStatusViaWebSession(reference)
        : this.checkStatusViaDirect(reference);
  }

  async getOperationalBalance() {
    return this.mode === "proxy"
      ? this.getBalanceViaProxy()
      : this.mode === "web"
        ? this.getBalanceViaWebSession()
        : this.getBalanceViaDirect();
  }

  // =========================================================================
  // DIRECT MODE (OAUTH2)
  // =========================================================================

  private async authenticateDirect(): Promise<string> {
    if (this.token && this.clock() < this.tokenExpiry) {
      return this.token;
    }

    const authHeader =
      "Basic " +
      Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`).toString(
        "base64",
      );

    const response = await this.sendRequest(this.directClient, {
      method: "POST",
      url: "/auth/oauth2/token",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Airtel direct auth failed with status ${response.status}`,
      );
    }

    const data = response.data as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error("Airtel direct auth did not return access_token");
    }

    this.token = data.access_token;
    this.tokenExpiry = this.clock() + (data.expires_in ?? 3600) * 1000 - 5000;

    return this.token;
  }

  private async executeViaDirect(
    operation: "payment" | "payout",
    phoneNumber: string,
    amount: string,
    reference: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    const endpoint =
      operation === "payment"
        ? this.config.paymentPath
        : this.config.payoutPath;

    const response = await this.requestDirectWithRetry({
      method: "POST",
      url: endpoint,
      data:
        operation === "payment"
          ? {
              reference,
              subscriber: {
                country: this.config.country,
                currency: this.config.currency,
                msisdn: phoneNumber,
              },
              transaction: {
                amount: parseFloat(amount),
                country: this.config.country,
                currency: this.config.currency,
                id: reference,
              },
            }
          : {
              reference,
              payee: {
                msisdn: phoneNumber,
              },
              transaction: {
                amount: parseFloat(amount),
                id: reference,
              },
            },
    });

    return this.toProviderResult(response, reference);
  }

  private async requestDirectWithRetry(
    request: AxiosRequestConfig,
  ): Promise<AxiosResponse> {
    let lastResponse: AxiosResponse | null = null;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        const token = await this.authenticateDirect();
        const requestHeaders = (request.headers ?? {}) as Record<
          string,
          string
        >;

        const response = await this.sendRequest(this.directClient, {
          ...request,
          headers: {
            ...requestHeaders,
            Authorization: `Bearer ${token}`,
            "X-Country": this.config.country,
            "X-Currency": this.config.currency,
            "Content-Type":
              requestHeaders["Content-Type"] ?? "application/json",
          },
        });

        if (response.status === 401 || response.status === 403) {
          this.token = null;
          lastResponse = response;
          continue;
        }

        if (response.status >= 500 && attempt < this.config.maxAttempts) {
          lastResponse = response;
          await this.delay(attempt);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= this.config.maxAttempts) {
          throw error;
        }
        await this.delay(attempt);
      }
    }

    if (lastResponse) {
      return lastResponse;
    }

    throw lastError ?? new Error("Airtel direct API request failed");
  }

  private async checkStatusViaDirect(
    reference: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    const response = await this.requestDirectWithRetry({
      method: "GET",
      url: this.formatPath(this.config.statusPath, reference),
    });

    return this.toProviderResult(response, reference);
  }

  private async getBalanceViaDirect(): Promise<{
    success: boolean;
    data?: { availableBalance: number; currency: string };
    error?: unknown;
  }> {
    const response = await this.requestDirectWithRetry({
      method: "GET",
      url: "/standard/v1/users/balance",
    });

    if (response.status < 200 || response.status >= 300) {
      return { success: false, error: response.data };
    }

    const data = response.data as AirtelBalanceResponse;
    const rawBalance =
      data.data?.availableBalance ??
      data.data?.balance ??
      data.availableBalance ??
      data.balance ??
      0;

    const availableBalance =
      typeof rawBalance === "number"
        ? rawBalance
        : Number.parseFloat(String(rawBalance));

    if (!Number.isFinite(availableBalance)) {
      return {
        success: false,
        error: new Error("Invalid balance response"),
      };
    }

    return {
      success: true,
      data: {
        availableBalance,
        currency: data.data?.currency || data.currency || this.config.currency,
      },
    };
  }

  // =========================================================================
  // WEB SESSION MODE
  // =========================================================================

  private async ensureSession(forceLogin = false): Promise<AirtelSessionState> {
    if (!forceLogin) {
      const cached = this.session ?? this.loadSession();
      if (cached && !this.isExpired(cached)) {
        this.session = cached;

        if (this.shouldRefresh(cached)) {
          return this.refreshSession(cached);
        }

        return cached;
      }
    }

    if (!this.sessionPromise || forceLogin) {
      this.sessionPromise = this.login();
    }

    try {
      return await this.sessionPromise;
    } finally {
      this.sessionPromise = null;
    }
  }

  private async login(): Promise<AirtelSessionState> {
    this.assertWebConfig();

    const loginPage = await this.sendRequest(this.client, {
      method: "GET",
      url: this.config.loginPath,
    });

    const initialSession = this.captureSession(loginPage);
    const csrfToken =
      this.extractCsrfToken(loginPage) ?? initialSession.csrfToken;

    const payload = new URLSearchParams();
    payload.set(this.config.usernameField, this.config.username);
    payload.set(this.config.passwordField, this.config.password);

    if (csrfToken) {
      payload.set(this.config.csrfField, csrfToken);
    }

    const loginResponse = await this.sendRequest(this.client, {
      method: "POST",
      url: this.config.loginPath,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: this.serializeCookies(initialSession),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
      data: payload.toString(),
    });

    if (loginResponse.status < 200 || loginResponse.status >= 300) {
      throw new Error(
        `Airtel login failed with status ${loginResponse.status}`,
      );
    }

    const session = this.captureSession(loginResponse, initialSession);
    session.csrfToken = this.extractCsrfToken(loginResponse) ?? csrfToken;
    this.session = this.ensureExpiresAt(session);
    this.persistSession(this.session);

    logger.info("Airtel: Web session established");

    return this.session;
  }

  private async refreshSession(
    session: AirtelSessionState,
  ): Promise<AirtelSessionState> {
    try {
      const response = await this.sendRequest(this.client, {
        method: "POST",
        url: this.config.refreshPath,
        headers: {
          Cookie: this.serializeCookies(session),
          ...(session.csrfToken ? { "X-CSRF-Token": session.csrfToken } : {}),
        },
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Airtel refresh failed with status ${response.status}`);
      }

      this.captureSession(response, session);
      session.csrfToken = this.extractCsrfToken(response) ?? session.csrfToken;
      this.session = this.ensureExpiresAt(session);
      this.persistSession(this.session);

      logger.info("Airtel: Web session refreshed");

      return this.session;
    } catch {
      this.session = null;
      return this.login();
    }
  }

  private async executeViaWebSession(
    operation: "payment" | "payout",
    phoneNumber: string,
    amount: string,
    reference: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    const endpoint =
      operation === "payment"
        ? this.config.paymentPath
        : this.config.payoutPath;

    const response = await this.requestWithSessionAndRetry(
      {
        method: "POST",
        url: endpoint,
        data:
          operation === "payment"
            ? {
                reference,
                subscriber: {
                  country: this.config.country,
                  currency: this.config.currency,
                  msisdn: phoneNumber,
                },
                transaction: {
                  amount: parseFloat(amount),
                  country: this.config.country,
                  currency: this.config.currency,
                  id: reference,
                },
              }
            : {
                reference,
                payee: {
                  msisdn: phoneNumber,
                },
                transaction: {
                  amount: parseFloat(amount),
                  id: reference,
                },
              },
      },
      operation,
    );

    return this.toProviderResult(response, reference);
  }

  private async requestWithSessionAndRetry(
    request: AxiosRequestConfig,
    operation: "payment" | "payout",
  ): Promise<AxiosResponse> {
    let lastResponse: AxiosResponse | null = null;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      const session = await this.ensureSession(attempt > 1);
      const requestHeaders = (request.headers ?? {}) as Record<string, string>;

      try {
        const response = await this.sendRequest(this.client, {
          ...request,
          headers: {
            ...requestHeaders,
            Cookie: this.serializeCookies(session),
            "X-CSRF-Token": session.csrfToken ?? "",
            "Idempotency-Key":
              requestHeaders["Idempotency-Key"] ??
              this.createReference(operation),
          },
        });

        this.captureSession(response, session);

        if (this.isSessionExpiredResponse(response)) {
          this.session = null;
          lastResponse = response;
          continue;
        }

        if (response.status >= 500 && attempt < this.config.maxAttempts) {
          lastResponse = response;
          await this.delay(attempt);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= this.config.maxAttempts) {
          throw error;
        }

        await this.delay(attempt);
      }
    }

    if (lastResponse) {
      return lastResponse;
    }

    throw lastError ?? new Error("Airtel web session request failed");
  }

  private async checkStatusViaWebSession(
    reference: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    const response = await this.requestWithSessionAndRetry(
      {
        method: "GET",
        url: this.formatPath(this.config.statusPath, reference),
      },
      "payment",
    );

    return this.toProviderResult(response, reference);
  }

  private async getBalanceViaWebSession(): Promise<{
    success: boolean;
    data?: { availableBalance: number; currency: string };
    error?: unknown;
  }> {
    const response = await this.requestWithSessionAndRetry(
      {
        method: "GET",
        url: "/standard/v1/users/balance",
      },
      "payment",
    );

    if (response.status < 200 || response.status >= 300) {
      return { success: false, error: response.data };
    }

    const data = response.data as AirtelBalanceResponse;
    const rawBalance =
      data.data?.availableBalance ??
      data.data?.balance ??
      data.availableBalance ??
      data.balance ??
      0;

    const availableBalance =
      typeof rawBalance === "number"
        ? rawBalance
        : Number.parseFloat(String(rawBalance));

    if (!Number.isFinite(availableBalance)) {
      return {
        success: false,
        error: new Error("Invalid balance response"),
      };
    }

    return {
      success: true,
      data: {
        availableBalance,
        currency: data.data?.currency || data.currency || this.config.currency,
      },
    };
  }

  // =========================================================================
  // PROXY MODE
  // =========================================================================

  private assertWebConfig(): void {
    if (!this.config.username || !this.config.password) {
      throw new Error("Airtel web mode requires username and password");
    }
  }

  private async executeViaProxy(
    operation: "payment" | "payout",
    phoneNumber: string,
    amount: string,
    reference: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    if (!this.proxyClient) {
      throw new Error("Proxy client not configured");
    }

    const endpoint =
      operation === "payment"
        ? this.config.paymentPath
        : this.config.payoutPath;

    const response = await this.sendRequest(this.proxyClient, {
      method: "POST",
      url: endpoint,
      headers: this.config.proxySecret
        ? { "X-Airtel-Proxy-Secret": this.config.proxySecret }
        : undefined,
      data:
        operation === "payment"
          ? {
              reference,
              subscriber: {
                country: this.config.country,
                currency: this.config.currency,
                msisdn: phoneNumber,
              },
              transaction: {
                amount: parseFloat(amount),
                country: this.config.country,
                currency: this.config.currency,
                id: reference,
              },
            }
          : {
              reference,
              payee: {
                msisdn: phoneNumber,
              },
              transaction: {
                amount: parseFloat(amount),
                id: reference,
              },
            },
    });

    return this.toProviderResult(response, reference);
  }

  private async checkStatusViaProxy(
    reference: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    if (!this.proxyClient) {
      throw new Error("Proxy client not configured");
    }

    const response = await this.sendRequest(this.proxyClient, {
      method: "GET",
      url: this.formatPath(this.config.statusPath, reference),
      headers: this.config.proxySecret
        ? { "X-Airtel-Proxy-Secret": this.config.proxySecret }
        : undefined,
    });

    return this.toProviderResult(response, reference);
  }

  private async getBalanceViaProxy(): Promise<{
    success: boolean;
    data?: { availableBalance: number; currency: string };
    error?: unknown;
  }> {
    if (!this.proxyClient) {
      throw new Error("Proxy client not configured");
    }

    const response = await this.sendRequest(this.proxyClient, {
      method: "GET",
      url: "/standard/v1/users/balance",
      headers: this.config.proxySecret
        ? { "X-Airtel-Proxy-Secret": this.config.proxySecret }
        : undefined,
    });

    if (response.status < 200 || response.status >= 300) {
      return { success: false, error: response.data };
    }

    const data = response.data as AirtelBalanceResponse;
    const rawBalance =
      data.data?.availableBalance ??
      data.data?.balance ??
      data.availableBalance ??
      data.balance ??
      0;

    const availableBalance =
      typeof rawBalance === "number"
        ? rawBalance
        : Number.parseFloat(String(rawBalance));

    if (!Number.isFinite(availableBalance)) {
      return {
        success: false,
        error: new Error("Invalid balance response"),
      };
    }

    return {
      success: true,
      data: {
        availableBalance,
        currency: data.data?.currency || data.currency || this.config.currency,
      },
    };
  }

  // =========================================================================
  // HELPER METHODS
  // =========================================================================

  private async sendRequest(
    client: AirtelHttpClient,
    request: AxiosRequestConfig,
  ): Promise<AxiosResponse> {
    if (client.request) {
      return client.request(request);
    }

    const method = (request.method ?? "GET").toUpperCase();
    const url = request.url;
    if (!url) {
      throw new Error("Airtel request URL is required");
    }

    const config: AxiosRequestConfig = { ...request };
    delete config.method;
    delete config.url;

    if (method === "GET" && client.get) {
      delete config.data;
      return client.get(url, config);
    }

    if (method === "POST" && client.post) {
      const data = config.data;
      delete config.data;
      return client.post(url, data, config);
    }

    throw new Error(`Airtel HTTP client does not support ${method}`);
  }

  private captureSession(
    response: AxiosResponse,
    existing?: AirtelSessionState,
  ): AirtelSessionState {
    const session: AirtelSessionState = existing ?? {
      cookies: {},
      expiresAt: this.clock() + this.config.sessionTtlMs,
      authenticatedAt: this.clock(),
    };

    for (const cookie of this.getSetCookieHeaders(response)) {
      const parsed = this.parseSetCookie(cookie);
      if (parsed) {
        session.cookies[parsed.name] = {
          value: parsed.value,
          expiresAt: parsed.expiresAt,
        };
      }
    }

    session.csrfToken = this.extractCsrfToken(response) ?? session.csrfToken;
    session.expiresAt =
      this.getEarliestCookieExpiry(session) ??
      session.expiresAt ??
      this.clock() + this.config.sessionTtlMs;

    return session;
  }

  private serializeCookies(session: AirtelSessionState): string {
    return Object.entries(session.cookies)
      .map(([name, { value }]) => `${name}=${value}`)
      .join("; ");
  }

  private getSetCookieHeaders(response: AxiosResponse): string[] {
    const headers = response.headers["set-cookie"];
    if (!headers) return [];
    if (Array.isArray(headers)) return headers;
    return [headers];
  }

  private parseSetCookie(
    cookie: string,
  ): { name: string; value: string; expiresAt?: number } | null {
    const parts = cookie.split(";");
    if (parts.length === 0) return null;

    const [nameValue] = parts[0].split("=");
    const [name, value] = [
      nameValue.trim(),
      parts[0].substring(nameValue.length + 1).trim(),
    ];

    let expiresAt: number | undefined;
    for (const part of parts.slice(1)) {
      const [key, val] = part.split("=");
      if (key.trim().toLowerCase() === "expires") {
        try {
          expiresAt = new Date(val.trim()).getTime();
        } catch {
          /* ignore */
        }
      } else if (key.trim().toLowerCase() === "max-age") {
        try {
          expiresAt = this.clock() + parseInt(val.trim(), 10) * 1000;
        } catch {
          /* ignore */
        }
      }
    }

    return { name, value, expiresAt };
  }

  private extractCsrfToken(response: AxiosResponse): string | undefined {
    let token: string | undefined;

    // Try response headers
    const headerToken = response.headers["x-csrf-token"];
    if (headerToken && typeof headerToken === "string") {
      token = headerToken;
    }

    // Try response body (common patterns)
    if (!token && response.data) {
      const data = response.data;
      if (typeof data === "string") {
        const match = data.match(
          /<input[^>]+name=["']_csrf["'][^>]+value=["']([^"']+)["']/,
        );
        if (match) {
          token = match[1];
        }
      } else if (typeof data === "object") {
        token = data._csrf || data.csrf || data.csrfToken;
      }
    }

    return token;
  }

  private getEarliestCookieExpiry(
    session: AirtelSessionState,
  ): number | undefined {
    let earliest: number | undefined;

    for (const { expiresAt } of Object.values(session.cookies)) {
      if (expiresAt && (!earliest || expiresAt < earliest)) {
        earliest = expiresAt;
      }
    }

    return earliest;
  }

  private isExpired(session: AirtelSessionState): boolean {
    return this.clock() >= session.expiresAt;
  }

  private shouldRefresh(session: AirtelSessionState): boolean {
    return this.clock() >= session.expiresAt - this.config.refreshSkewMs;
  }

  private ensureExpiresAt(session: AirtelSessionState): AirtelSessionState {
    if (!session.expiresAt || session.expiresAt === 0) {
      session.expiresAt = this.clock() + this.config.sessionTtlMs;
    }
    return session;
  }

  private persistSession(_session: AirtelSessionState): void {
    // Session tokens contain sensitive authentication credentials.
    // Writing them to the local filesystem (sessionStorePath) would create
    // unencrypted secrets on disk, violating the memory-only security policy.
    // The session is already held in memory via this.session; for cross-process
    // persistence use an encrypted store such as Redis instead.
  }

  private loadSession(): AirtelSessionState | null {
    // Session tokens must not be read from the local filesystem.
    // The in-memory this.session is the authoritative cache; a fresh
    // login will be performed when it is absent or expired.
    return null;
  }

  private isSessionExpiredResponse(response: AxiosResponse): boolean {
    return (
      response.status === 401 ||
      response.status === 403 ||
      (typeof response.data === "object" &&
        response.data !== null &&
        (response.data.error === "unauthorized" ||
          response.data.message?.includes("session")))
    );
  }

  private toProviderResult(
    response: AxiosResponse,
    reference?: string,
  ): { success: boolean; data?: unknown; error?: unknown } {
    if (response.status < 200 || response.status >= 300) {
      return { success: false, error: response.data };
    }

    return { success: true, data: response.data };
  }

  private formatPath(pathTemplate: string, reference: string): string {
    return pathTemplate.replace(":reference", reference);
  }

  private createReference(operation: "payment" | "payout"): string {
    if (operation === "payout") {
      return `AIRTEL-PAYOUT-${Date.now()}`;
    }
    return `AIRTEL-${Date.now()}`;
  }

  private async delay(attempt: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}
