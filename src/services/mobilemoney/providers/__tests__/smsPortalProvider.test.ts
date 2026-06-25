import { SmsPortalProvider } from "../smsPortalProvider";

const mockSubmitFormAndExtract = jest.fn();
const mockNavigateAndExtract = jest.fn();
const mockEnsureSession = jest.fn();
const mockDestroy = jest.fn();

jest.mock("../smsPortalSimulator", () => ({
  SmsPortalSimulator: jest.fn().mockImplementation(() => ({
    submitFormAndExtract: mockSubmitFormAndExtract,
    navigateAndExtract: mockNavigateAndExtract,
    ensureSession: mockEnsureSession,
    destroy: mockDestroy,
  })),
}));

const env = { ...process.env };

describe("SmsPortalProvider", () => {
  let provider: SmsPortalProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
    provider = new SmsPortalProvider();
  });

  afterAll(() => {
    process.env = env;
  });

  describe("requestPayment", () => {
    it("returns success when simulator succeeds", async () => {
      mockSubmitFormAndExtract.mockResolvedValue({ success: true, data: { message: "Payment sent", reference: "ref-1" } });

      const result = await provider.requestPayment("+261700000000", "5000", "ref-1");

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ message: "Payment sent", reference: "ref-1" });
      expect(mockSubmitFormAndExtract).toHaveBeenCalledTimes(1);
    });

    it("returns failure when simulator returns error", async () => {
      mockSubmitFormAndExtract.mockResolvedValue({ success: false, error: "Insufficient balance" });

      const result = await provider.requestPayment("+261700000000", "5000");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Insufficient balance");
    });

    it("returns failure when simulator throws", async () => {
      mockSubmitFormAndExtract.mockRejectedValue(new Error("Browser crashed"));

      const result = await provider.requestPayment("+261700000000", "5000");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("generates a reference when none provided", async () => {
      mockSubmitFormAndExtract.mockResolvedValue({ success: true, data: { reference: expect.stringContaining("SMS-PAYMENT-") } });

      const result = await provider.requestPayment("+261700000000", "5000");

      expect(result.success).toBe(true);
    });
  });

  describe("sendPayout", () => {
    it("returns success when simulator succeeds", async () => {
      mockSubmitFormAndExtract.mockResolvedValue({ success: true, data: { message: "Payout sent", reference: "payout-1" } });

      const result = await provider.sendPayout("+261700000000", "10000", "payout-1");

      expect(result.success).toBe(true);
      expect(mockSubmitFormAndExtract).toHaveBeenCalledTimes(1);
    });

    it("returns failure when simulator returns error", async () => {
      mockSubmitFormAndExtract.mockResolvedValue({ success: false, error: "Daily limit exceeded" });

      const result = await provider.sendPayout("+261700000000", "10000");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Daily limit exceeded");
    });

    it("returns failure when simulator throws", async () => {
      mockSubmitFormAndExtract.mockRejectedValue(new Error("Network error"));

      const result = await provider.sendPayout("+261700000000", "10000");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("getTransactionStatus", () => {
    it("returns completed status", async () => {
      mockNavigateAndExtract.mockResolvedValue("completed");

      const result = await provider.getTransactionStatus("ref-1");

      expect(result.status).toBe("completed");
    });

    it("returns failed status", async () => {
      mockNavigateAndExtract.mockResolvedValue("failed");

      const result = await provider.getTransactionStatus("ref-1");

      expect(result.status).toBe("failed");
    });

    it("returns pending status", async () => {
      mockNavigateAndExtract.mockResolvedValue("pending");

      const result = await provider.getTransactionStatus("ref-1");

      expect(result.status).toBe("pending");
    });

    it("returns unknown status", async () => {
      mockNavigateAndExtract.mockResolvedValue("unknown");

      const result = await provider.getTransactionStatus("ref-1");

      expect(result.status).toBe("unknown");
    });

    it("returns unknown on error", async () => {
      mockNavigateAndExtract.mockRejectedValue(new Error("Portal unavailable"));

      const result = await provider.getTransactionStatus("ref-1");

      expect(result.status).toBe("unknown");
    });
  });

  describe("setCaptchaSolver", () => {
    it("sets captcha solver without error", () => {
      const solver = jest.fn();
      expect(() => provider.setCaptchaSolver(solver)).not.toThrow();
    });
  });
});
