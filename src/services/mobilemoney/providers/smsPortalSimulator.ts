import { Browser, BrowserContext, Page, chromium } from "playwright";
import logger from "../../../utils/logger";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StoredCookie {
  value: string;
  expiresAt?: number;
}

export interface SessionState {
  cookies: Record<string, StoredCookie>;
  csrfToken?: string;
  expiresAt: number;
  authenticatedAt: number;
}

export type CaptchaSolver = (page: Page) => Promise<boolean>;

export interface SmsPortalSimulatorConfig {
  portalUrl: string;
  loginPath: string;
  username: string;
  password: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  csrfSelector?: string;
  sessionTtlMs: number;
  refreshSkewMs: number;
  browserTimeoutMs: number;
  navigationTimeoutMs: number;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  userAgent: string;
  captchaSelector?: string;
  captchaSolver?: CaptchaSolver;
  sessionStorePath?: string;
  encryptionKey?: string;
  successIndicatorSelector?: string;
  errorIndicatorSelector?: string;
}

const DEFAULTS = {
  sessionTtlMs: 20 * 60 * 1000,
  refreshSkewMs: 60 * 1000,
  browserTimeoutMs: 30_000,
  navigationTimeoutMs: 30_000,
  headless: true,
  viewportWidth: 1280,
  viewportHeight: 800,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// ── Simulator ────────────────────────────────────────────────────────────────

export class SmsPortalSimulator {
  private config: SmsPortalSimulatorConfig;
  private session: SessionState | null = null;
  private sessionPromise: Promise<SessionState> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private clock: () => number;

  constructor(config: Partial<SmsPortalSimulatorConfig> = {}) {
    this.clock = Date.now;
    this.config = this.buildConfig(config);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async ensureSession(forceLogin = false): Promise<SessionState> {
    if (!forceLogin) {
      if (this.session && !this.isExpired(this.session)) {
        if (this.shouldRefresh(this.session)) {
          return this.refreshSession();
        }
        return this.session;
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

  async navigateAndExtract<T>(
    url: string,
    extract: (page: Page) => Promise<T>,
  ): Promise<T> {
    await this.ensureSession();
    return this.withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle" });
      await this.handleCaptchaIfPresent(page);
      return extract(page);
    });
  }

  async submitFormAndExtract<T>(
    url: string,
    formValues: Record<string, string>,
    submitSelector: string,
    extract: (page: Page) => Promise<T>,
  ): Promise<T> {
    await this.ensureSession();
    return this.withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle" });
      await this.handleCaptchaIfPresent(page);

      for (const [selector, value] of Object.entries(formValues)) {
        await page.fill(selector, value);
      }

      await page.click(submitSelector);
      await page.waitForLoadState("networkidle");

      return extract(page);
    });
  }

  private async withPage<T>(
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      browser = await chromium.launch({
        headless: this.config.headless,
        timeout: this.config.browserTimeoutMs,
        args: [
          `--window-size=${this.config.viewportWidth},${this.config.viewportHeight}`,
          "--disable-blink-features=AutomationControlled",
        ],
      });

      context = await browser.newContext({
        viewport: {
          width: this.config.viewportWidth,
          height: this.config.viewportHeight,
        },
        userAgent: this.config.userAgent,
      });

      if (this.session) {
        await context.addCookies(
          Object.entries(this.session.cookies).map(([name, c]) => ({
            name,
            value: c.value,
            domain: new URL(this.config.portalUrl).hostname,
            path: "/",
            ...(c.expiresAt ? { expires: Math.round(c.expiresAt / 1000) } : {}),
          })),
        );
      }

      const page = await context.newPage();
      page.setDefaultTimeout(this.config.navigationTimeoutMs);

      return await fn(page);
    } finally {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  private async login(): Promise<SessionState> {
    logger.info("SmsPortalSimulator: Logging in");

    const session = await this.withPage(async (page) => {
      await page.goto(
        `${this.config.portalUrl}${this.config.loginPath}`,
        { waitUntil: "networkidle" },
      );
      await this.handleCaptchaIfPresent(page);

      await page.fill(this.config.usernameSelector, this.config.username);
      await page.fill(this.config.passwordSelector, this.config.password);

      const csrfToken = await this.extractCsrfToken(page);
      await page.click(this.config.submitSelector);

      try {
        await page.waitForNavigation({ waitUntil: "networkidle", timeout: this.config.navigationTimeoutMs });
      } catch {
        // Navigation may not happen if the page updates in-place
        await page.waitForLoadState("networkidle");
      }

      const currentUrl = page.url();
      const loginFailed =
        currentUrl.includes("login") ||
        currentUrl.includes("error") ||
        currentUrl.includes("auth");

      if (loginFailed && this.config.errorIndicatorSelector) {
        const errorEl = await page.$(this.config.errorIndicatorSelector);
        if (errorEl) {
          const errorText = await errorEl.textContent();
          throw new Error(`SMS portal login failed: ${errorText ?? "unknown error"}`);
        }
      }

      if (loginFailed) {
        throw new Error("SMS portal login failed — still on login page after submit");
      }

      const cookies = await page.context().cookies();
      const sessionState: SessionState = {
        cookies: Object.fromEntries(
          cookies.map((c) => [
            c.name,
            {
              value: c.value,
              expiresAt: c.expires ? c.expires * 1000 : undefined,
            },
          ]),
        ),
        csrfToken: csrfToken ?? undefined,
        expiresAt: this.clock() + this.config.sessionTtlMs,
        authenticatedAt: this.clock(),
      };

      return sessionState;
    });

    this.session = this.ensureExpiresAt(session);
    this.scheduleRefresh();
    return this.session;
  }

  private async refreshSession(): Promise<SessionState> {
    if (!this.session) {
      return this.login();
    }

    try {
      logger.info("SmsPortalSimulator: Refreshing session");
      const refreshed = await this.navigateAndExtract(
        `${this.config.portalUrl}${this.config.loginPath}`,
        async (page) => {
          // Check if already logged in by looking for a known element
          if (this.config.successIndicatorSelector) {
            const indicator = await page.$(this.config.successIndicatorSelector);
            if (indicator) {
              // Session is still valid — just update cookie timestamps
              const cookies = await page.context().cookies();
              if (this.session) {
                for (const c of cookies) {
                  if (this.session.cookies[c.name]) {
                    this.session.cookies[c.name].value = c.value;
                    if (c.expires) {
                      this.session.cookies[c.name].expiresAt = c.expires * 1000;
                    }
                  }
                }
              }
              return this.session!;
            }
          }
          throw new Error("Session refresh needed — re-logging in");
        },
      );
      this.session = this.ensureExpiresAt(refreshed);
      return this.session;
    } catch {
      logger.warn("SmsPortalSimulator: Session refresh failed, re-logging in");
      return this.login();
    }
  }

  private async handleCaptchaIfPresent(page: Page): Promise<void> {
    if (!this.config.captchaSelector) return;

    const captchaEl = await page.$(this.config.captchaSelector);
    if (!captchaEl) return;

    logger.info("SmsPortalSimulator: Captcha detected");

    if (this.config.captchaSolver) {
      const solved = await this.config.captchaSolver(page);
      if (solved) {
        logger.info("SmsPortalSimulator: Captcha solved");
        return;
      }
    }

    // If no captcha solver is configured, log a warning but continue
    // The caller can configure a solver to avoid being blocked
    logger.warn({
      msg: "SmsPortalSimulator: Captcha present but no solver configured",
      captchaSelector: this.config.captchaSelector,
      pageUrl: page.url(),
    });
  }

  private async extractCsrfToken(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta) return meta.getAttribute("content");

      const input = document.querySelector<HTMLInputElement>(
        'input[name="_csrf"], input[name="csrf_token"], input[name="csrf"]',
      );
      return input?.value ?? null;
    });
  }

  private scheduleRefresh(): void {
    if (this.destroyed) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);

    const delay = Math.max(1000, this.config.sessionTtlMs - this.config.refreshSkewMs);

    this.refreshTimer = setTimeout(async () => {
      if (this.destroyed) return;
      try {
        await this.refreshSession();
      } catch (err: any) {
        logger.error({ err: err.message }, "SmsPortalSimulator: Scheduled refresh failed");
      }
    }, delay);

    if (this.refreshTimer && typeof this.refreshTimer.unref === "function") {
      this.refreshTimer.unref();
    }
  }

  private buildConfig(
    overrides: Partial<SmsPortalSimulatorConfig>,
  ): SmsPortalSimulatorConfig {
    return {
      portalUrl:
        overrides.portalUrl ??
        process.env.SMS_PORTAL_URL ??
        "",
      loginPath:
        overrides.loginPath ??
        process.env.SMS_PORTAL_LOGIN_PATH ??
        "/login",
      username:
        overrides.username ??
        process.env.SMS_PORTAL_USERNAME ??
        "",
      password:
        overrides.password ??
        process.env.SMS_PORTAL_PASSWORD ??
        "",
      usernameSelector:
        overrides.usernameSelector ??
        process.env.SMS_PORTAL_USERNAME_SELECTOR ??
        '[name="username"]',
      passwordSelector:
        overrides.passwordSelector ??
        process.env.SMS_PORTAL_PASSWORD_SELECTOR ??
        '[name="password"]',
      submitSelector:
        overrides.submitSelector ??
        process.env.SMS_PORTAL_SUBMIT_SELECTOR ??
        'button[type="submit"]',
      csrfSelector:
        overrides.csrfSelector ?? process.env.SMS_PORTAL_CSRF_SELECTOR,
      sessionTtlMs: Number(
        overrides.sessionTtlMs ??
          process.env.SMS_PORTAL_SESSION_TTL_MS ??
          DEFAULTS.sessionTtlMs,
      ),
      refreshSkewMs: Number(
        overrides.refreshSkewMs ??
          process.env.SMS_PORTAL_REFRESH_SKEW_MS ??
          DEFAULTS.refreshSkewMs,
      ),
      browserTimeoutMs: Number(
        overrides.browserTimeoutMs ??
          process.env.SMS_PORTAL_BROWSER_TIMEOUT_MS ??
          DEFAULTS.browserTimeoutMs,
      ),
      navigationTimeoutMs: Number(
        overrides.navigationTimeoutMs ??
          process.env.SMS_PORTAL_NAV_TIMEOUT_MS ??
          DEFAULTS.navigationTimeoutMs,
      ),
      headless:
        overrides.headless ??
        process.env.SMS_PORTAL_HEADLESS !== "false",
      viewportWidth: Number(
        overrides.viewportWidth ??
          process.env.SMS_PORTAL_VIEWPORT_WIDTH ??
          DEFAULTS.viewportWidth,
      ),
      viewportHeight: Number(
        overrides.viewportHeight ??
          process.env.SMS_PORTAL_VIEWPORT_HEIGHT ??
          DEFAULTS.viewportHeight,
      ),
      userAgent:
        overrides.userAgent ??
        process.env.SMS_PORTAL_USER_AGENT ??
        DEFAULTS.userAgent,
      captchaSelector:
        overrides.captchaSelector ??
        process.env.SMS_PORTAL_CAPTCHA_SELECTOR,
      captchaSolver: overrides.captchaSolver,
      sessionStorePath:
        overrides.sessionStorePath ??
        process.env.SMS_PORTAL_SESSION_STORE_PATH,
      encryptionKey:
        overrides.encryptionKey ??
        process.env.SMS_PORTAL_ENCRYPTION_KEY,
      successIndicatorSelector:
        overrides.successIndicatorSelector ??
        process.env.SMS_PORTAL_SUCCESS_INDICATOR_SELECTOR,
      errorIndicatorSelector:
        overrides.errorIndicatorSelector ??
        process.env.SMS_PORTAL_ERROR_INDICATOR_SELECTOR,
    };
  }

  private isExpired(session: SessionState): boolean {
    return session.expiresAt <= this.clock();
  }

  private shouldRefresh(session: SessionState): boolean {
    return session.expiresAt - this.clock() <= this.config.refreshSkewMs;
  }

  private ensureExpiresAt(session: SessionState): SessionState {
    if (!session.expiresAt || session.expiresAt <= this.clock()) {
      session.expiresAt = this.clock() + this.config.sessionTtlMs;
    }
    return session;
  }
}
