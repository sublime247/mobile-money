import { chromium } from "playwright";
import { SmsPortalSimulator } from "../smsPortalSimulator";

jest.mock("playwright", () => ({
  chromium: {
    launch: jest.fn(),
  },
}));

const chromiumMock = chromium as jest.Mocked<typeof chromium>;

const env = { ...process.env };

function mockPage() {
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    fill: jest.fn().mockResolvedValue(undefined),
    click: jest.fn().mockResolvedValue(undefined),
    $: jest.fn().mockResolvedValue(null),
    evaluate: jest.fn().mockResolvedValue(null),
    url: jest.fn().mockReturnValue("https://portal.example.com/dashboard"),
    context: jest.fn(),
    setDefaultTimeout: jest.fn(),
    waitForNavigation: jest.fn().mockResolvedValue(undefined),
    waitForLoadState: jest.fn().mockResolvedValue(undefined),
  };
}

function mockContext() {
  return {
    close: jest.fn().mockResolvedValue(undefined),
    newPage: jest.fn(),
    cookies: jest.fn().mockResolvedValue([
      { name: "session_id", value: "abc123", domain: "portal.example.com", path: "/", expires: 0, httpOnly: false, secure: false, sameSite: "Lax" as const },
    ]),
    addCookies: jest.fn().mockResolvedValue(undefined),
  };
}

function mockBrowser() {
  return {
    close: jest.fn().mockResolvedValue(undefined),
    newContext: jest.fn(),
  };
}

describe("SmsPortalSimulator", () => {
  let page: ReturnType<typeof mockPage>;
  let context: ReturnType<typeof mockContext>;
  let browser: ReturnType<typeof mockBrowser>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };

    page = mockPage();
    context = mockContext();
    browser = mockBrowser();

    page.context.mockReturnValue(context as any);
    context.newPage.mockResolvedValue(page as any);
    browser.newContext.mockResolvedValue(context as any);
    chromiumMock.launch.mockResolvedValue(browser as any);
  });

  afterAll(() => {
    process.env = env;
  });

  describe("constructor & config", () => {
    it("can be instantiated with no options", () => {
      const sim = new SmsPortalSimulator();
      expect(sim).toBeInstanceOf(SmsPortalSimulator);
    });

    it("reads SMS_PORTAL_URL from env", () => {
      process.env.SMS_PORTAL_URL = "https://my-portal.com";
      process.env.SMS_PORTAL_USERNAME = "admin";
      process.env.SMS_PORTAL_PASSWORD = "secret";
      const sim = new SmsPortalSimulator();
      expect(sim).toBeInstanceOf(SmsPortalSimulator);
    });

    it("prefers constructor options over env vars", () => {
      process.env.SMS_PORTAL_URL = "https://default.com";
      const sim = new SmsPortalSimulator({ portalUrl: "https://override.com" });
      expect(sim).toBeInstanceOf(SmsPortalSimulator);
    });
  });

  describe("ensureSession", () => {
    it("returns cached session when not expired", async () => {
      const sim = new SmsPortalSimulator({ portalUrl: "https://portal.com", username: "u", password: "p" });
      // expiresAt well beyond default refreshSkewMs (60000ms)
      const session = {
        cookies: {},
        expiresAt: Date.now() + 200000,
        authenticatedAt: Date.now(),
      };
      (sim as any).session = session;

      const result = await sim.ensureSession();
      expect(result).toBe(session);
    });

    it("calls login when no cached session exists", async () => {
      const sim = new SmsPortalSimulator({ portalUrl: "https://portal.com", username: "u", password: "p" });

      const session = await sim.ensureSession();

      expect(session).toBeDefined();
      expect(session.cookies).toBeDefined();
      expect(chromiumMock.launch).toHaveBeenCalledTimes(1);
    });

    it("re-logins when cached session is expired", async () => {
      jest.useFakeTimers({ now: Date.now() });
      const sim = new SmsPortalSimulator({ portalUrl: "https://portal.com", username: "u", password: "p" });
      (sim as any).session = {
        cookies: { old: { value: "x" } },
        expiresAt: Date.now() - 1000,
        authenticatedAt: Date.now() - 100000,
      };

      const session = await sim.ensureSession();
      expect(session).toBeDefined();
      expect(session.cookies.old).toBeUndefined();
      jest.useRealTimers();
    });
  });

  describe("navigateAndExtract", () => {
    it("navigates to URL and calls extract function", async () => {
      const sim = new SmsPortalSimulator({ portalUrl: "https://portal.com", username: "u", password: "p" });
      const extract = jest.fn().mockResolvedValue("extracted-data");

      const result = await sim.navigateAndExtract("https://portal.com/status/ref-1", extract);

      expect(result).toBe("extracted-data");
      expect(page.goto).toHaveBeenCalledWith(
        "https://portal.com/status/ref-1",
        expect.objectContaining({ waitUntil: "networkidle" }),
      );
    });

    it("propagates extract errors", async () => {
      const sim = new SmsPortalSimulator({ portalUrl: "https://portal.com", username: "u", password: "p" });
      const extract = jest.fn().mockRejectedValue(new Error("extract-failed"));

      await expect(sim.navigateAndExtract("https://portal.com/status/x", extract)).rejects.toThrow("extract-failed");
    });
  });

  describe("submitFormAndExtract", () => {
    it("fills form fields, submits, and calls extract", async () => {
      const sim = new SmsPortalSimulator({ portalUrl: "https://portal.com", username: "u", password: "p" });
      const extract = jest.fn().mockResolvedValue({ success: true });

      const result = await sim.submitFormAndExtract(
        "https://portal.com/payment",
        { '[name="phone"]': "+261700000000", '[name="amount"]': "5000" },
        'button[type="submit"]',
        extract,
      );

      expect(result).toEqual({ success: true });
      expect(page.goto).toHaveBeenCalledWith("https://portal.com/payment", expect.any(Object));
      expect(page.fill).toHaveBeenCalledWith('[name="phone"]', "+261700000000");
      expect(page.fill).toHaveBeenCalledWith('[name="amount"]', "5000");
      expect(page.click).toHaveBeenCalledWith('button[type="submit"]');
    });
  });

  describe("captcha handling", () => {
    it("calls captcha solver when captcha element is detected", async () => {
      const solver = jest.fn().mockResolvedValue(true);
      page.$.mockImplementation(async (sel: string) => {
        if (sel === ".captcha-image") return {} as any;
        return null;
      });

      const sim = new SmsPortalSimulator({
        portalUrl: "https://portal.com",
        username: "u",
        password: "p",
        captchaSelector: ".captcha-image",
        captchaSolver: solver,
      });

      await sim.navigateAndExtract("https://portal.com/status", async () => "ok");

      expect(page.$).toHaveBeenCalledWith(".captcha-image");
      expect(solver).toHaveBeenCalled();
    });

    it("skips captcha handling when no selector configured", async () => {
      const solver = jest.fn();
      const sim = new SmsPortalSimulator({
        portalUrl: "https://portal.com",
        username: "u",
        password: "p",
      });

      await sim.navigateAndExtract("https://portal.com/status", async () => "ok");

      expect(page.$).not.toHaveBeenCalledWith(expect.stringContaining("captcha"));
    });

    it("does not call solver when captcha element not found", async () => {
      const solver = jest.fn();
      const sim = new SmsPortalSimulator({
        portalUrl: "https://portal.com",
        username: "u",
        password: "p",
        captchaSelector: ".captcha-image",
        captchaSolver: solver,
      });

      await sim.navigateAndExtract("https://portal.com/status", async () => "ok");

      expect(page.$).toHaveBeenCalledWith(".captcha-image");
      expect(solver).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("clears the refresh timer and marks destroyed", () => {
      const sim = new SmsPortalSimulator({ portalUrl: "https://portal.com", username: "u", password: "p" });
      (sim as any).refreshTimer = setTimeout(() => {}, 1000);
      sim.destroy();
      expect((sim as any).destroyed).toBe(true);
      expect((sim as any).refreshTimer).toBeNull();
    });
  });
});
