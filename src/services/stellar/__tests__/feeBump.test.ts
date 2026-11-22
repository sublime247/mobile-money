import {
  getSponsorWalletPublicKey,
  getSponsorWalletThreshold,
  getSponsorWalletBalance,
  sendSponsorLowBalanceAlert,
  checkFeeBumpSponsorBalance,
  runSponsorWalletMonitorJob,
} from "../feeBump";
import { notifySlackAlert } from "../../loggers";
import { emailService } from "../../email";

jest.mock("../../loggers", () => ({
  notifySlackAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../email", () => ({
  emailService: {
    sendAdminBalanceAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

describe("Stellar Fee-Bump Sponsor Wallet Monitoring (Issue #1526)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("getSponsorWalletPublicKey", () => {
    it("reads public key from STELLAR_FEE_BUMP_SPONSOR_ACCOUNT", () => {
      process.env.STELLAR_FEE_BUMP_SPONSOR_ACCOUNT =
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
      expect(getSponsorWalletPublicKey()).toBe(
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      );
    });

    it("falls back to STELLAR_SPONSOR_PUBLIC_KEY", () => {
      delete process.env.STELLAR_FEE_BUMP_SPONSOR_ACCOUNT;
      process.env.STELLAR_SPONSOR_PUBLIC_KEY =
        "GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35GDG3X0PXHQK6ACIG26563EEE";
      expect(getSponsorWalletPublicKey()).toBe(
        "GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35GDG3X0PXHQK6ACIG26563EEE",
      );
    });

    it("returns null when no sponsor account is configured", () => {
      delete process.env.STELLAR_FEE_BUMP_SPONSOR_ACCOUNT;
      delete process.env.STELLAR_SPONSOR_PUBLIC_KEY;
      delete process.env.STELLAR_SPONSOR_ACCOUNT;
      delete process.env.STELLAR_ISSUER_ACCOUNT;
      delete process.env.STELLAR_FEE_BUMP_SPONSOR_SECRET;
      delete process.env.STELLAR_SPONSOR_SECRET;
      delete process.env.STELLAR_ISSUER_SECRET;
      expect(getSponsorWalletPublicKey()).toBeNull();
    });
  });

  describe("getSponsorWalletThreshold", () => {
    it("returns default 50 XLM when env is not set", () => {
      delete process.env.FEE_BUMP_SPONSOR_BALANCE_THRESHOLD_XLM;
      delete process.env.SPONSOR_WALLET_MIN_BALANCE_XLM;
      expect(getSponsorWalletThreshold()).toBe(50);
    });

    it("respects FEE_BUMP_SPONSOR_BALANCE_THRESHOLD_XLM env variable", () => {
      process.env.FEE_BUMP_SPONSOR_BALANCE_THRESHOLD_XLM = "120.5";
      expect(getSponsorWalletThreshold()).toBe(120.5);
    });
  });

  describe("getSponsorWalletBalance", () => {
    it("extracts native XLM balance from server account response", async () => {
      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue({
          balances: [
            { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "500.00" },
            { asset_type: "native", balance: "42.5000000" },
          ],
        }),
      } as any;

      const balance = await getSponsorWalletBalance(
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        mockServer,
      );

      expect(balance).toBe(42.5);
      expect(mockServer.loadAccount).toHaveBeenCalledWith(
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      );
    });

    it("returns 0 if no native balance exists on account", async () => {
      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue({
          balances: [
            { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "500.00" },
          ],
        }),
      } as any;

      const balance = await getSponsorWalletBalance(
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        mockServer,
      );

      expect(balance).toBe(0);
    });
  });

  describe("checkFeeBumpSponsorBalance & Alerts", () => {
    const testPubKey =
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

    it("triggers Slack and Email alerts when balance falls below threshold", async () => {
      process.env.ADMIN_ALERT_EMAILS = "admin@example.com,ops@example.com";

      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue({
          balances: [{ asset_type: "native", balance: "35.0000000" }], // 35 XLM < 50 XLM
        }),
      } as any;

      const result = await checkFeeBumpSponsorBalance({
        publicKey: testPubKey,
        threshold: 50,
        server: mockServer,
      });

      expect(result.lowBalance).toBe(true);
      expect(result.alerted).toBe(true);
      expect(result.balance).toBe(35);
      expect(result.threshold).toBe(50);

      // Verify Slack Alert
      expect(notifySlackAlert).toHaveBeenCalledTimes(1);
      expect(notifySlackAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/jobs/sponsor-wallet-monitor",
          error: expect.any(Error),
        }),
      );

      // Verify Email Alert
      expect(emailService.sendAdminBalanceAlert).toHaveBeenCalledTimes(2);
    });

    it("does not trigger alerts when balance is healthy (>= threshold)", async () => {
      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue({
          balances: [{ asset_type: "native", balance: "150.0000000" }], // 150 XLM >= 50 XLM
        }),
      } as any;

      const result = await checkFeeBumpSponsorBalance({
        publicKey: testPubKey,
        threshold: 50,
        server: mockServer,
      });

      expect(result.lowBalance).toBe(false);
      expect(result.alerted).toBe(false);
      expect(result.balance).toBe(150);
      expect(notifySlackAlert).not.toHaveBeenCalled();
      expect(emailService.sendAdminBalanceAlert).not.toHaveBeenCalled();
    });

    it("handles errors gracefully without throwing", async () => {
      const mockServer = {
        loadAccount: jest.fn().mockRejectedValue(new Error("Horizon 500 server error")),
      } as any;

      const result = await checkFeeBumpSponsorBalance({
        publicKey: testPubKey,
        threshold: 50,
        server: mockServer,
      });

      expect(result.lowBalance).toBe(false);
      expect(result.alerted).toBe(false);
      expect(result.error).toBe("Horizon 500 server error");
    });
  });

  describe("runSponsorWalletMonitorJob", () => {
    it("runs successfully without throwing", async () => {
      process.env.STELLAR_FEE_BUMP_SPONSOR_ACCOUNT =
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

      await expect(runSponsorWalletMonitorJob()).resolves.toBeUndefined();
    });
  });
});
