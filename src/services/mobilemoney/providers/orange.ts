import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import * as fs from "fs";
import * as path from "path";
import logger from "../../../utils/logger";
import { maskPII } from "../../../utils/masking";
import { Browser, BrowserContext, Page, chromium } from "playwright";

type OrangeOperation = "payment" | "payout";
type OrangeMode = "web" | "direct" | "proxy";

type OrangeResult = {
  success: boolean;
  data?: unknown;
  error?: unknown;
  reference?: string;
};

type OrangeSessionState = {
  cookies: Record<string, StoredCookie>;
  csrfToken?: string;
  expiresAt: number;
  authenticatedAt: number;
};

type StoredCookie = {
  value: string;
  expiresAt?: number;
};

type OrangeHttpClient = Partial<
  Pick<AxiosInstance, "request" | "get" | "post">
>;

type OrangeProviderConfig = {
  mode?: OrangeMode;
  webBaseUrl: string;
  directBaseUrl: string;
  loginPath: string;
  refreshPath: string;
  paymentPath: string;
  payoutPath: string;
  statusPath: string;
  directAuthPath: string;
  directPaymentPath: string;
  directPayoutPath: string;
  directStatusPath: string;
  username: string;
  password: string;
  apiKey: string;
  apiSecret: string;
  usernameField: string;
  passwordField: string;
  csrfField: string;
  currency: string;
  sessionStorePath?: string;
  sessionTtlMs: number;
  refreshSkewMs: number;
  requestTimeoutMs: number;
  maxAttempts: number;
  proxyBaseUrl?: string;
  proxySecret?: string;
  // Headless browser options for web session mode
  useHeadlessBrowser?: boolean;
  headless?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  userAgent?: string;
  browserTimeoutMs?: number;
  navigationTimeoutMs?: number;
};

export type OrangeProviderOptions = Partial<OrangeProviderConfig> & {
  baseUrl?: string;
  httpClient?: OrangeHttpClient;
  proxyHttpClient?: OrangeHttpClient;
  directHttpClient?: OrangeHttpClient;
  clock?: () => number;
};

const DEFAULT_SESSION_TTL_MS = 20 * 60 * 1000;
const DEFAULT_REFRESH_SKEW_MS = 60 * 1000;

export class OrangeProvider {
  private readonly config: OrangeProviderConfig;
  private readonly mode: OrangeMode;
  private readonly client: OrangeHttpClient;
  private readonly proxyClient?: OrangeHttpClient;
  private readonly directClient: OrangeHttpClient;
  private readonly clock: () => number;
  private session: OrangeSessionState | null = null;
  private sessionPromise: Promise<OrangeSessionState> | null = null;
  private apiToken: string | null = null;
  private apiTokenExpiry = 0;

  constructor(options: OrangeProviderOptions = {}) {
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
  }

  async requestPayment(
    phoneNumber: string,
    amount: string | number,
    requestId?: string,
  ): Promise<OrangeResult> {
    return this.executeOperation(
      "payment",
      phoneNumber,
      String(amount),
      requestId,
    );
  }

  async sendPayout(
    phoneNumber: string,
    amount: string | number,
    requestId?: string,
  ): Promise<OrangeResult> {
    return this.executeOperation(
      "payout",
      phoneNumber,
      String(amount),
      requestId,
    );
  }

  async checkStatus(reference: string): Promise<OrangeResult> {
    try {
      if (this.mode === "proxy") {
        const response = await this.sendRequest(this.proxyClient!, {
          method: "GET",
          url: this.formatPath(this.config.statusPath, reference),
          headers: this.config.proxySecret
            ? { "X-Orange-Proxy-Secret": this.config.proxySecret }
            : undefined,
        });

        return this.toProviderResult(response, reference);
      }

      if (this.mode === "direct") {
        const response = await this.requestDirect({
          method: "GET",
          url: this.formatPath(this.config.directStatusPath, reference),
        });

        return this.toProviderResult(response, reference);
      }

      const response = await this.requestWithSession(
        {
          method: "GET",
          url: this.formatPath(this.config.statusPath, reference),
        },
        "payment",
      );

      return this.toProviderResult(response, reference);
    } catch (error) {
      return { success: false, error, reference };
    }
  }

  private buildConfig(options: OrangeProviderOptions): OrangeProviderConfig {
    return {
      mode: options.mode ?? (process.env.ORANGE_MODE as OrangeMode | undefined),
      webBaseUrl:
        options.webBaseUrl ??
        options.baseUrl ??
        process.env.ORANGE_WEB_BASE_URL ??
        "",
      directBaseUrl:
        options.directBaseUrl ??
        options.baseUrl ??
        process.env.ORANGE_BASE_URL ??
        "https://sandbox.orange.com",
      loginPath: options.loginPath ?? process.env.ORANGE_LOGIN_PATH ?? "/login",
      refreshPath:
        options.refreshPath ??
        process.env.ORANGE_REFRESH_PATH ??
        "/session/refresh",
      paymentPath:
        options.paymentPath ??
        process.env.ORANGE_PAYMENT_PATH ??
        "/transactions/collections",
      payoutPath:
        options.payoutPath ??
        process.env.ORANGE_PAYOUT_PATH ??
        "/transactions/payouts",
      statusPath:
        options.statusPath ??
        process.env.ORANGE_STATUS_PATH ??
        "/transactions/:reference",
      directAuthPath:
        options.directAuthPath ??
        process.env.ORANGE_DIRECT_AUTH_PATH ??
        "/oauth/token",
      directPaymentPath:
        options.directPaymentPath ??
        process.env.ORANGE_DIRECT_PAYMENT_PATH ??
        "/v1/payments/collect",
      directPayoutPath:
        options.directPayoutPath ??
        process.env.ORANGE_DIRECT_PAYOUT_PATH ??
        "/v1/payments/disburse",
      directStatusPath:
        options.directStatusPath ??
        process.env.ORANGE_DIRECT_STATUS_PATH ??
        "/v1/payments/:reference",
      username:
        options.username ??
        process.env.ORANGE_USERNAME ??
        process.env.ORANGE_API_KEY ??
        "",
      password:
        options.password ??
        process.env.ORANGE_PASSWORD ??
        process.env.ORANGE_API_SECRET ??
        "",
      apiKey: options.apiKey ?? process.env.ORANGE_API_KEY ?? "",
      apiSecret: options.apiSecret ?? process.env.ORANGE_API_SECRET ?? "",
      usernameField:
        options.usernameField ??
        process.env.ORANGE_USERNAME_FIELD ??
        "username",
      passwordField:
        options.passwordField ??
        process.env.ORANGE_PASSWORD_FIELD ??
        "password",
      csrfField: options.csrfField ?? process.env.ORANGE_CSRF_FIELD ?? "_csrf",
      currency: options.currency ?? process.env.ORANGE_CURRENCY ?? "XAF",
      sessionStorePath:
        options.sessionStorePath ?? process.env.ORANGE_SESSION_STORE_PATH,
      sessionTtlMs: Number(
        options.sessionTtlMs ??
          process.env.ORANGE_SESSION_TTL_MS ??
          DEFAULT_SESSION_TTL_MS,
      ),
      refreshSkewMs: Number(
        options.refreshSkewMs ??
          process.env.ORANGE_REFRESH_SKEW_MS ??
          DEFAULT_REFRESH_SKEW_MS,
      ),
      requestTimeoutMs: Number(
        options.requestTimeoutMs ?? process.env.REQUEST_TIMEOUT_MS ?? 30000,
      ),
      maxAttempts: Number(
        options.maxAttempts ?? process.env.ORANGE_MAX_ATTEMPTS ?? 3,
      ),
      proxyBaseUrl: options.proxyBaseUrl ?? process.env.ORANGE_PROXY_URL,
      proxySecret: options.proxySecret ?? process.env.ORANGE_PROXY_SECRET,
      // Headless browser options
      useHeadlessBrowser:
        options.useHeadlessBrowser ??
        process.env.ORANGE_USE_HEADLESS_BROWSER === "true",
      headless: options.headless ?? process.env.ORANGE_HEADLESS !== "false", // default to true
      viewportWidth: Number(
        options.viewportWidth ?? process.env.ORANGE_VIEWPORT_WIDTH ?? 1280,
      ),
      viewportHeight: Number(
        options.viewportHeight ?? process.env.ORANGE_VIEWPORT_HEIGHT ?? 800,
      ),
      userAgent: options.userAgent ?? process.env.ORANGE_USER_AGENT ?? "",
      browserTimeoutMs: Number(
        options.browserTimeoutMs ??
          process.env.ORANGE_BROWSER_TIMEOUT_MS ??
          30000,
      ),
      navigationTimeoutMs: Number(
        options.navigationTimeoutMs ??
          process.env.ORANGE_NAVIGATION_TIMEOUT_MS ??
          30000,
      ),
    };
  }

  private async sendRequest(
    client: OrangeHttpClient,
    request: AxiosRequestConfig,
  ): Promise<AxiosResponse> {
    if (client.request) {
      return client.request(request);
    }

    const method = (request.method ?? "GET").toUpperCase();
    const url = request.url;
    if (!url) {
      throw new Error("Orange request URL is required");
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

    throw new Error(`Orange HTTP client does not support ${method}`);
  }

  private resolveMode(): OrangeMode {
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

  private async executeOperation(
    operation: OrangeOperation,
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<OrangeResult> {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(
      maskPII({ phoneNumber, amount, operation, mode: this.mode }),
      "Orange: Executing operation",
    );
    const startTime = Date.now();
    try {
      const response = await (async () => {
        if (this.mode === "proxy") {
          return await this.executeViaProxy(operation, phoneNumber, amount);
        }

        if (this.mode === "direct") {
          return await this.executeViaDirectApi(operation, phoneNumber, amount);
        }

        this.assertWebConfig();
        const reference = this.createReference(operation);
        const resp = await this.requestWithSession(
          {
            method: "POST",
            url:
              operation === "payment"
                ? this.config.paymentPath
                : this.config.payoutPath,
            data: {
              amount,
              currency: this.config.currency,
              msisdn: phoneNumber,
              reference,
            },
          },
          operation,
        );
        return this.toProviderResult(resp, reference);
      })();

      const duration = Date.now() - startTime;
      log.info(
        maskPII({ duration, success: response.success !== false }),
        "Orange: Operation completed",
      );
      return response;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      log.error({ duration, error: error.message }, "Orange: Operation failed");
      return { success: false, error };
    }
  }

  private async executeViaProxy(
    operation: OrangeOperation,
    phoneNumber: string,
    amount: string,
  ): Promise<OrangeResult> {
    const reference = this.createReference(operation);
    const response = await this.sendRequest(this.proxyClient!, {
      method: "POST",
      url:
        operation === "payment"
          ? this.config.paymentPath
          : this.config.payoutPath,
      headers: this.config.proxySecret
        ? { "X-Orange-Proxy-Secret": this.config.proxySecret }
        : undefined,
      data: {
        amount,
        currency: this.config.currency,
        msisdn: phoneNumber,
        reference,
      },
    });

    return this.toProviderResult(response, reference);
  }

  private async executeViaDirectApi(
    operation: OrangeOperation,
    phoneNumber: string,
    amount: string,
  ): Promise<OrangeResult> {
    const reference = this.createReference(operation);
    const endpoint =
      operation === "payment"
        ? this.config.directPaymentPath
        : this.config.directPayoutPath;
    const response = await this.requestDirect({
      method: "POST",
      url: endpoint,
      data:
        operation === "payment"
          ? {
              reference,
              subscriber: { msisdn: phoneNumber },
              transaction: {
                amount: parseFloat(amount),
                currency: this.config.currency,
                id: reference,
              },
            }
          : {
              reference,
              payee: { msisdn: phoneNumber },
              transaction: {
                amount: parseFloat(amount),
                currency: this.config.currency,
                id: reference,
              },
            },
    });

    return this.toProviderResult(response, reference);
  }

  private async requestDirect(
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
            "Content-Type":
              requestHeaders["Content-Type"] ?? "application/json",
          },
        });

        if (response.status === 401 || response.status === 403) {
          this.apiToken = null;
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

    throw lastError ?? new Error("Orange direct API request failed");
  }

  private async authenticateDirect(): Promise<string> {
    if (this.apiToken && this.clock() < this.apiTokenExpiry) {
      return this.apiToken;
    }

    if (this.config.mode === "direct") {
      this.assertDirectConfig();
    }

    const authHeader =
      "Basic " +
      Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`).toString(
        "base64",
      );
    const response = await this.sendRequest(this.directClient, {
      method: "POST",
      url: this.config.directAuthPath,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: "grant_type=client_credentials",
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Orange direct auth failed with status ${response.status}`,
      );
    }

    const data = response.data as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error("Orange direct auth did not return access_token");
    }

    this.apiToken = data.access_token;
    this.apiTokenExpiry =
      this.clock() + (data.expires_in ?? 3600) * 1000 - 5000;

    return this.apiToken;
  }

  private async requestWithSession(
    request: AxiosRequestConfig,
    operation: OrangeOperation,
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
              this.getRequestReference(request, operation),
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

    throw lastError ?? new Error("Orange request failed");
  }

  private async ensureSession(forceLogin = false): Promise<OrangeSessionState> {
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

  private async loginWithPlaywright(): Promise<OrangeSessionState> {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      browser = await chromium.launch({
        headless: this.config.headless ?? true,
        timeout: this.config.browserTimeoutMs ?? 30000,
        args: [
          `--window-size=${this.config.viewportWidth ?? 1280},${this.config.viewportHeight ?? 800}`,
          // Add any other useful args for handling challenges
          "--disable-blink-features=AutomationControlled",
        ],
      });

      context = await browser.newContext({
        viewport: {
          width: this.config.viewportWidth ?? 1280,
          height: this.config.viewportHeight ?? 800,
        },
        userAgent:
          this.config.userAgent ??
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      const page = await context.newPage();
      page.setDefaultTimeout(this.config.navigationTimeoutMs ?? 30000);

      // Navigate to login page
      await page.goto(`${this.config.webBaseUrl}${this.config.loginPath}`, {
        waitUntil: "networkidle",
      });

      // Handle potential challenges here - for now we just proceed with login
      // In a real implementation, we would detect and solve CAPTCHAs, JS challenges, etc.

      // Fill in login form
      await page.fill(
        `[name="${this.config.usernameField}"]`,
        this.config.username,
      );
      await page.fill(
        `[name="${this.config.passwordField}"]`,
        this.config.password,
      );

      // Handle CSRF token if needed
      const csrfToken = await page.evaluate(() => {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute("content") : null;
      });
      if (csrfToken) {
        await page.fill(`[name="${this.config.csrfField}"]`, csrfToken);
      }

      // Submit form
      await page.click('button[type="submit"], input[type="submit"]');
      await page.waitForNavigation({ waitUntil: "networkidle" });

      // Check if login was successful (simple check - in reality we'd check for success indicators)
      const url = page.url();
      if (url.includes("login") || url.includes("error")) {
        throw new Error(
          "Login failed - possible challenge or invalid credentials",
        );
      }

      // Extract session from browser context
      const cookies = await context.cookies();
      const session: OrangeSessionState = {
        cookies: Object.fromEntries(
          cookies.map((c) => [
            c.name,
            {
              value: c.value,
              expiresAt: c.expires ? c.expires * 1000 : undefined,
            },
          ]),
        ),
        csrfToken: await page.evaluate(() => {
          const token = document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content");
          return token ?? null;
        }),
        expiresAt:
          Date.now() + (this.config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS),
        authenticatedAt: Date.now(),
      };

      return this.ensureExpiresAt(session);
    } finally {
      if (context) {
        await context.close();
      }
      if (browser) {
        await browser.close();
      }
    }
  }

  private async login(): Promise<OrangeSessionState> {
    // Use Playwright for login if headless browser is enabled
    if (this.config.useHeadlessBrowser) {
      return await this.loginWithPlaywright();
    }

    // Original axios-based login
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
        `Orange login failed with status ${loginResponse.status}`,
      );
    }

    const session = this.captureSession(loginResponse, initialSession);
    session.csrfToken = this.extractCsrfToken(loginResponse) ?? csrfToken;
    this.session = this.ensureExpiresAt(session);
    this.persistSession(this.session);

    return this.session;
  }

  private async refreshSession(
    session: OrangeSessionState,
  ): Promise<OrangeSessionState> {
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
        throw new Error(`Orange refresh failed with status ${response.status}`);
      }

      this.captureSession(response, session);
      session.csrfToken = this.extractCsrfToken(response) ?? session.csrfToken;
      this.session = this.ensureExpiresAt(session);
      this.persistSession(this.session);

      return this.session;
    } catch {
      this.session = null;
      return this.login();
    }
  }

  private captureSession(
    response: AxiosResponse,
    existing?: OrangeSessionState,
  ): OrangeSessionState {
    const session: OrangeSessionState = existing ?? {
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

  private loadSession(): OrangeSessionState | null {
    if (!this.config.sessionStorePath) {
      return null;
    }

    try {
      if (!fs.existsSync(this.config.sessionStorePath)) {
        return null;
      }

      const raw = fs.readFileSync(this.config.sessionStorePath, "utf8");
      const parsed = JSON.parse(raw) as OrangeSessionState;

      if (!parsed.cookies || !parsed.expiresAt || this.isExpired(parsed)) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  private persistSession(session: OrangeSessionState): void {
    if (!this.config.sessionStorePath) {
      return;
    }

    const dir = path.dirname(this.config.sessionStorePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.config.sessionStorePath, JSON.stringify(session), {
      mode: 0o600,
    });
  }

  private serializeCookies(session: OrangeSessionState): string {
    const now = this.clock();

    return Object.entries(session.cookies)
      .filter(([, cookie]) => !cookie.expiresAt || cookie.expiresAt > now)
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join("; ");
  }

  private parseSetCookie(
    header: string,
  ): { name: string; value: string; expiresAt?: number } | null {
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");

    if (separator <= 0) {
      return null;
    }

    const cookie: { name: string; value: string; expiresAt?: number } = {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
    };

    for (const attribute of attributes) {
      const [key, value] = attribute.split("=");
      if (key.toLowerCase() === "expires" && value) {
        const expiresAt = Date.parse(value);
        if (!Number.isNaN(expiresAt)) {
          cookie.expiresAt = expiresAt;
        }
      }

      if (key.toLowerCase() === "max-age" && value) {
        const seconds = Number(value);
        if (!Number.isNaN(seconds)) {
          cookie.expiresAt = this.clock() + seconds * 1000;
        }
      }
    }

    return cookie;
  }

  private getSetCookieHeaders(response: AxiosResponse): string[] {
    const headers = response.headers as Record<
      string,
      string | string[] | undefined
    >;
    const value = headers["set-cookie"] ?? headers["Set-Cookie"];

    if (!value) {
      return [];
    }

    return Array.isArray(value) ? value : [value];
  }

  private extractCsrfToken(response: AxiosResponse): string | undefined {
    const headers = response.headers as Record<string, string | undefined>;
    const headerToken = headers["x-csrf-token"] ?? headers["X-CSRF-Token"];

    if (headerToken) {
      return headerToken;
    }

    if (typeof response.data !== "string") {
      return undefined;
    }

    const html = response.data;
    const metaMatch = html.match(
      /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i,
    );
    const inputMatch = html.match(
      /<input[^>]+name=["'](?:_csrf|csrf_token|csrf)["'][^>]+value=["']([^"']+)["']/i,
    );
    const reversedInputMatch = html.match(
      /<input[^>]+value=["']([^"']+)["'][^>]+name=["'](?:_csrf|csrf_token|csrf)["']/i,
    );

    return metaMatch?.[1] ?? inputMatch?.[1] ?? reversedInputMatch?.[1];
  }

  private ensureExpiresAt(session: OrangeSessionState): OrangeSessionState {
    if (!session.expiresAt || session.expiresAt <= this.clock()) {
      session.expiresAt = this.clock() + this.config.sessionTtlMs;
    }

    return session;
  }

  private getEarliestCookieExpiry(
    session: OrangeSessionState,
  ): number | undefined {
    const expiries = Object.values(session.cookies)
      .map((cookie) => cookie.expiresAt)
      .filter((expiresAt): expiresAt is number => Boolean(expiresAt));

    return expiries.length > 0 ? Math.min(...expiries) : undefined;
  }

  private isExpired(session: OrangeSessionState): boolean {
    return session.expiresAt <= this.clock();
  }

  private shouldRefresh(session: OrangeSessionState): boolean {
    return session.expiresAt - this.clock() <= this.config.refreshSkewMs;
  }

  private isSessionExpiredResponse(response: AxiosResponse): boolean {
    if ([401, 403, 419, 440].includes(response.status)) {
      return true;
    }

    const headers = response.headers as Record<string, string | undefined>;
    const location = headers["location"] ?? headers["Location"];
    return Boolean(location?.includes(this.config.loginPath));
  }

  private toProviderResult(
    response: AxiosResponse,
    reference?: string,
  ): OrangeResult {
    const status = response.status ?? 200;

    if (status >= 200 && status < 300) {
      return { success: true, data: response.data, reference };
    }

    return {
      success: false,
      reference,
      error: {
        status,
        data: response.data,
      },
    };
  }

  private assertWebConfig(): void {
    if (!this.config.webBaseUrl) {
      throw new Error("ORANGE_WEB_BASE_URL is required for web session mode");
    }

    if (!this.config.username || !this.config.password) {
      throw new Error(
        "ORANGE_USERNAME/ORANGE_PASSWORD or ORANGE_API_KEY/ORANGE_API_SECRET are required",
      );
    }
  }

  private assertDirectConfig(): void {
    if (!this.config.apiKey || !this.config.apiSecret) {
      throw new Error("ORANGE_API_KEY and ORANGE_API_SECRET are required");
    }
  }

  private createReference(operation: OrangeOperation): string {
    return `ORANGE-${operation.toUpperCase()}-${this.clock()}`;
  }

  private getRequestReference(
    request: AxiosRequestConfig,
    operation: OrangeOperation,
  ): string {
    const data = request.data as { reference?: string } | undefined;
    return data?.reference ?? this.createReference(operation);
  }

  private formatPath(template: string, reference: string): string {
    return template.includes(":reference")
      ? template.replace(":reference", encodeURIComponent(reference))
      : `${template.replace(/\/$/, "")}/${encodeURIComponent(reference)}`;
  }

  private async delay(attempt: number): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250 * attempt, 1000)),
    );
  }
}
