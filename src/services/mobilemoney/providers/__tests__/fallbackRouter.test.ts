import { FallbackRouter } from "../fallbackRouter";
import { SmsPortalProvider } from "../smsPortalProvider";
import { MobileMoneyProvider, ProviderTransactionStatus } from "../../mobileMoneyService";

jest.mock("../smsPortalSimulator", () => ({
  SmsPortalSimulator: jest.fn().mockImplementation(() => ({
    submitFormAndExtract: jest.fn(),
    navigateAndExtract: jest.fn(),
    ensureSession: jest.fn(),
    destroy: jest.fn(),
  })),
}));

const env = { ...process.env };

function createMockProvider(name: string): jest.Mocked<MobileMoneyProvider> {
  return {
    requestPayment: jest.fn(),
    sendPayout: jest.fn(),
    getTransactionStatus: jest.fn(),
    sendBatchPayout: jest.fn(),
  } as any;
}

describe("FallbackRouter", () => {
  let primary: jest.Mocked<MobileMoneyProvider>;
  let fallback: SmsPortalProvider;
  let router: FallbackRouter;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
    process.env.FALLBACK_ROUTER_TIMEOUT_MS = "5000";
    primary = createMockProvider("primary");
    fallback = new SmsPortalProvider();
    router = new FallbackRouter(primary, fallback, { timeoutMs: 5000, enableMetrics: false });
  });

  afterAll(() => {
    process.env = env;
  });

  describe("requestPayment", () => {
    it("returns primary result on success", async () => {
      primary.requestPayment.mockResolvedValue({ success: true, data: { reference: "ref-1" } });

      const result = await router.requestPayment("+261700000000", "5000");

      expect(result).toEqual({ success: true, data: { reference: "ref-1" } });
      expect(primary.requestPayment).toHaveBeenCalledTimes(1);
    });

    it("falls back to SMS portal when primary times out", async () => {
      primary.requestPayment.mockRejectedValue(new Error("ETIMEDOUT"));
      jest.spyOn(fallback, "requestPayment").mockResolvedValue({ success: true, data: { reference: "fallback-ref" } });

      const result = await router.requestPayment("+261700000000", "5000");

      expect(result).toEqual({ success: true, data: { reference: "fallback-ref" } });
    });

    it("falls back when primary returns a timeout error code", async () => {
      primary.requestPayment.mockRejectedValue(Object.assign(new Error("timeout"), { code: "ECONNABORTED" }));
      jest.spyOn(fallback, "requestPayment").mockResolvedValue({ success: true, data: {} });

      const result = await router.requestPayment("+261700000000", "5000");

      expect(result.success).toBe(true);
    });

    it("returns failure when both primary and fallback fail", async () => {
      primary.requestPayment.mockRejectedValue(new Error("ETIMEDOUT"));
      jest.spyOn(fallback, "requestPayment").mockResolvedValue({ success: false, error: "Fallback failed" });

      const result = await router.requestPayment("+261700000000", "5000");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Fallback failed");
    });

    it("returns primary error for non-timeout failures", async () => {
      const err = new Error("Invalid credentials");
      primary.requestPayment.mockRejectedValue(err);

      const result = await router.requestPayment("+261700000000", "5000");

      expect(result.success).toBe(false);
      expect(result.error).toBe(err);
    });
  });

  describe("sendPayout", () => {
    it("returns primary result on success", async () => {
      primary.sendPayout.mockResolvedValue({ success: true, data: { reference: "payout-1" } });

      const result = await router.sendPayout("+261700000000", "10000");

      expect(result.success).toBe(true);
    });

    it("falls back when primary times out", async () => {
      primary.sendPayout.mockRejectedValue(new Error("timed out"));
      jest.spyOn(fallback, "sendPayout").mockResolvedValue({ success: true, data: {} });

      const result = await router.sendPayout("+261700000000", "10000");

      expect(result.success).toBe(true);
    });

    it("returns failure when both primary and fallback fail", async () => {
      primary.sendPayout.mockRejectedValue(new Error("ETIMEDOUT"));
      jest.spyOn(fallback, "sendPayout").mockResolvedValue({ success: false, error: "Fallback error" });

      const result = await router.sendPayout("+261700000000", "10000");

      expect(result.success).toBe(false);
    });
  });

  describe("getTransactionStatus", () => {
    it("returns primary status on success", async () => {
      primary.getTransactionStatus.mockResolvedValue({ status: "completed" });

      const result = await router.getTransactionStatus("ref-1");

      expect(result).toEqual({ status: "completed" });
    });

    it("falls back when primary throws", async () => {
      primary.getTransactionStatus.mockRejectedValue(new Error("timeout"));
      jest.spyOn(fallback, "getTransactionStatus").mockResolvedValue({ status: "pending" });

      const result = await router.getTransactionStatus("ref-1");

      expect(result).toEqual({ status: "pending" });
    });

    it("returns unknown when both fail", async () => {
      primary.getTransactionStatus.mockRejectedValue(new Error("timeout"));
      jest.spyOn(fallback, "getTransactionStatus").mockResolvedValue({ status: "unknown" });

      const result = await router.getTransactionStatus("ref-1");

      expect(result).toEqual({ status: "unknown" });
    });
  });

  describe("sendBatchPayout", () => {
    it("delegates to primary when it supports batch", async () => {
      const items = [
        { referenceId: "tx1", phoneNumber: "+261700000001", amount: "500" },
        { referenceId: "tx2", phoneNumber: "+261700000002", amount: "1000" },
      ];
      primary.sendBatchPayout.mockResolvedValue({
        success: true,
        results: [
          { referenceId: "tx1", success: true, providerReference: "pmt-1" },
          { referenceId: "tx2", success: false, error: "blocked" },
        ],
      });

      const result = await router.sendBatchPayout(items);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
    });

    it("falls back to individual payouts when primary throws", async () => {
      primary.sendBatchPayout.mockRejectedValue(new Error("timeout"));
      jest.spyOn(fallback, "sendPayout").mockResolvedValue({ success: true, data: { reference: "fb-1" } });

      const items = [{ referenceId: "tx1", phoneNumber: "+261700000001", amount: "500" }];
      const result = await router.sendBatchPayout(items);

      expect(result.success).toBe(true);
      expect(fallback.sendPayout).toHaveBeenCalledTimes(1);
    });

    it("reports individual failures in batch fallback", async () => {
      primary.sendBatchPayout.mockRejectedValue(new Error("timeout"));
      jest.spyOn(fallback, "sendPayout").mockResolvedValue({ success: false, error: "Provider down" });

      const items = [{ referenceId: "tx1", phoneNumber: "+261700000001", amount: "500" }];
      const result = await router.sendBatchPayout(items);

      expect(result.success).toBe(false);
      expect(result.results[0].success).toBe(false);
    });
  });
});
