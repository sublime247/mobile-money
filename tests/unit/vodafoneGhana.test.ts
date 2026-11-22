import axios from "axios";
import { createHmac } from "crypto";
import { VodafoneGhanaProvider } from "../../src/services/mobilemoney/providers/vodafoneGhana";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

/** Build a minimal fake axios instance returned by axios.create */
function makeClient(overrides: Record<string, jest.Mock> = {}) {
  return {
    post: jest.fn(),
    get: jest.fn(),
    ...overrides,
  };
}

describe("VodafoneGhanaProvider", () => {
  let fakeClient: ReturnType<typeof makeClient>;
  let provider: VodafoneGhanaProvider;

  beforeEach(() => {
    jest.resetAllMocks();

    fakeClient = makeClient();
    mockedAxios.create = jest.fn().mockReturnValue(fakeClient);

    process.env.VODAFONE_GH_API_KEY = "test-key";
    process.env.VODAFONE_GH_API_SECRET = "test-secret";
    process.env.VODAFONE_GH_MERCHANT_CODE = "MERCH-001";
    process.env.VODAFONE_GH_CALLBACK_SECRET = "test-webhook-secret";
    process.env.VODAFONE_GH_CURRENCY = "GHS";
    process.env.VODAFONE_GH_BASE_URL = "https://sandbox.vodafone.com.gh";

    provider = new VodafoneGhanaProvider();
  });

  afterEach(() => {
    delete process.env.VODAFONE_GH_API_KEY;
    delete process.env.VODAFONE_GH_API_SECRET;
    delete process.env.VODAFONE_GH_MERCHANT_CODE;
    delete process.env.VODAFONE_GH_CALLBACK_SECRET;
    delete process.env.VODAFONE_GH_CURRENCY;
    delete process.env.VODAFONE_GH_BASE_URL;
  });

  // ─── Constructor ──────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("creates axios instance with Basic auth", () => {
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "https://sandbox.vodafone.com.gh",
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("falls back to default base URL when VODAFONE_GH_BASE_URL is not set", () => {
      delete process.env.VODAFONE_GH_BASE_URL;
      new VodafoneGhanaProvider();
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "https://sandbox.vodafone.com.gh" }),
      );
    });
  });

  // ─── requestPayment ───────────────────────────────────────────────────────

  describe("requestPayment", () => {
    const mockCollection = {
      transactionId: "vf_123",
      status: "pending",
    };

    it("returns success with collection data", async () => {
      fakeClient.post.mockResolvedValue({ data: mockCollection });

      const result = await provider.requestPayment("233241234567", "50");

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockCollection);
    });

    it("posts to /v1/collections endpoint", async () => {
      fakeClient.post.mockResolvedValue({ data: mockCollection });

      await provider.requestPayment("233241234567", "50");

      expect(fakeClient.post).toHaveBeenCalledWith(
        "/v1/collections",
        expect.objectContaining({
          merchantCode: "MERCH-001",
          amount: "50",
          currency: "GHS",
          msisdn: "233241234567",
        }),
      );
    });

    it("includes voucherCode in the payload when provided (#1961)", async () => {
      fakeClient.post.mockResolvedValue({ data: mockCollection });

      await provider.requestPayment("233241234567", "50", "VOUCH-9999");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.voucherCode).toBe("VOUCH-9999");
    });

    it("omits voucherCode from the payload when not provided", async () => {
      fakeClient.post.mockResolvedValue({ data: mockCollection });

      await provider.requestPayment("233241234567", "50");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body).not.toHaveProperty("voucherCode");
    });

    it("normalizes phone number (strips leading 0, prepends 233)", async () => {
      fakeClient.post.mockResolvedValue({ data: mockCollection });

      await provider.requestPayment("0241234567", "50");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.msisdn).toBe("233241234567");
    });

    it("keeps phone number unchanged when already prefixed with 233", async () => {
      fakeClient.post.mockResolvedValue({ data: mockCollection });

      await provider.requestPayment("233241234567", "50");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.msisdn).toBe("233241234567");
    });

    it("includes clientReference in the payload", async () => {
      fakeClient.post.mockResolvedValue({ data: mockCollection });

      await provider.requestPayment("233241234567", "50");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.clientReference).toMatch(/^VODAFONE-GH-PAY-/);
    });

    it("returns success:false when request throws", async () => {
      const networkError = new Error("Network error");
      fakeClient.post.mockRejectedValue(networkError);

      const result = await provider.requestPayment("233241234567", "50");

      expect(result.success).toBe(false);
      expect(result.error).toBe(networkError);
    });
  });

  // ─── sendPayout ───────────────────────────────────────────────────────────

  describe("sendPayout", () => {
    const mockPayout = { transactionId: "vf_payout_1", status: "pending" };

    it("returns success with payout data", async () => {
      fakeClient.post.mockResolvedValue({ data: mockPayout });

      const result = await provider.sendPayout("233241234567", "30");

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockPayout);
    });

    it("posts to /v1/disbursements endpoint", async () => {
      fakeClient.post.mockResolvedValue({ data: mockPayout });

      await provider.sendPayout("233241234567", "30");

      expect(fakeClient.post).toHaveBeenCalledWith(
        "/v1/disbursements",
        expect.objectContaining({
          merchantCode: "MERCH-001",
          amount: "30",
          currency: "GHS",
          msisdn: "233241234567",
        }),
      );
    });

    it("returns success:false when request throws", async () => {
      fakeClient.post.mockRejectedValue(new Error("timeout"));

      const result = await provider.sendPayout("233241234567", "30");

      expect(result.success).toBe(false);
    });
  });

  // ─── getTransactionStatus ─────────────────────────────────────────────────

  describe("getTransactionStatus", () => {
    it.each([
      ["success", "completed"],
      ["successful", "completed"],
      ["completed", "completed"],
      ["failed", "failed"],
      ["error", "failed"],
      ["declined", "failed"],
      ["pending", "pending"],
      ["processing", "pending"],
      ["unknown_state", "unknown"],
      ["", "unknown"],
    ])("maps Vodafone status '%s' → '%s'", async (vodafoneStatus, expected) => {
      fakeClient.get.mockResolvedValue({ data: { status: vodafoneStatus } });

      const result = await provider.getTransactionStatus("vf_001");

      expect(result.status).toBe(expected);
    });

    it("calls GET /v1/transactions/:id", async () => {
      fakeClient.get.mockResolvedValue({ data: { status: "success" } });

      await provider.getTransactionStatus("vf_001");

      expect(fakeClient.get).toHaveBeenCalledWith("/v1/transactions/vf_001");
    });

    it("returns unknown when request throws", async () => {
      fakeClient.get.mockRejectedValue(new Error("not found"));

      const result = await provider.getTransactionStatus("vf_bad");

      expect(result.status).toBe("unknown");
    });
  });

  // ─── verifyWebhookSignature ───────────────────────────────────────────────

  describe("verifyWebhookSignature", () => {
    const secret = "test-webhook-secret";
    const body = JSON.stringify({ event: "collection.completed", id: "evt_1" });

    function makeSignature(payload: string | Buffer, key: string): string {
      return (
        "sha256=" + createHmac("sha256", key).update(payload).digest("hex")
      );
    }

    it("returns true for a valid HMAC-SHA256 signature", () => {
      const sig = makeSignature(body, secret);
      expect(provider.verifyWebhookSignature(body, sig)).toBe(true);
    });

    it("returns false for a tampered body", () => {
      const sig = makeSignature(body, secret);
      expect(provider.verifyWebhookSignature(body + " tampered", sig)).toBe(
        false,
      );
    });

    it("returns false for a wrong secret", () => {
      const sig = makeSignature(body, "wrong-secret");
      expect(provider.verifyWebhookSignature(body, sig)).toBe(false);
    });

    it("returns false when VODAFONE_GH_CALLBACK_SECRET is not configured", () => {
      delete process.env.VODAFONE_GH_CALLBACK_SECRET;
      const providerNoSecret = new VodafoneGhanaProvider();
      const sig = makeSignature(body, secret);

      expect(providerNoSecret.verifyWebhookSignature(body, sig)).toBe(false);
    });

    it("accepts a Buffer body", () => {
      const bufBody = Buffer.from(body);
      const sig = makeSignature(bufBody, secret);

      expect(provider.verifyWebhookSignature(bufBody, sig)).toBe(true);
    });
  });

  // ─── parseCallback (#1961) ────────────────────────────────────────────────

  describe("parseCallback", () => {
    it("normalizes a completed collection callback", () => {
      const result = VodafoneGhanaProvider.parseCallback({
        transactionId: "vf_e2e",
        status: "SUCCESSFUL",
        amount: "50",
        currency: "GHS",
        msisdn: "233241234567",
        voucherCode: "VOUCH-1",
      });

      expect(result).toEqual({
        transactionId: "vf_e2e",
        status: "completed",
        amount: "50",
        currency: "GHS",
        msisdn: "233241234567",
        voucherCode: "VOUCH-1",
        failureReason: undefined,
      });
    });

    it("falls back to referenceId when transactionId is absent", () => {
      const result = VodafoneGhanaProvider.parseCallback({
        referenceId: "ref-only",
        status: "pending",
      });

      expect(result.transactionId).toBe("ref-only");
      expect(result.status).toBe("pending");
    });

    it("normalizes a failed callback with a failure reason", () => {
      const result = VodafoneGhanaProvider.parseCallback({
        transactionId: "vf_fail",
        status: "FAILED",
        failureReason: "insufficient_funds",
      });

      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("insufficient_funds");
    });

    it("handles a numeric amount", () => {
      const result = VodafoneGhanaProvider.parseCallback({
        transactionId: "vf_amt",
        status: "success",
        amount: 75,
      });

      expect(result.amount).toBe("75");
    });

    it("returns an empty transactionId and unknown status when payload has neither", () => {
      const result = VodafoneGhanaProvider.parseCallback({});

      expect(result.transactionId).toBe("");
      expect(result.status).toBe("unknown");
    });
  });

  // ─── End-to-end mock flow ─────────────────────────────────────────────────

  describe("end-to-end mock flow", () => {
    it("completes a full voucher-authorized payment → status check flow", async () => {
      fakeClient.post.mockResolvedValueOnce({
        data: { transactionId: "vf_voucher_e2e", status: "pending" },
      });

      const paymentResult = await provider.requestPayment(
        "233241234567",
        "150",
        "VOUCH-E2E",
      );
      expect(paymentResult.success).toBe(true);
      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.voucherCode).toBe("VOUCH-E2E");

      fakeClient.get.mockResolvedValueOnce({
        data: { transactionId: "vf_voucher_e2e", status: "success" },
      });

      const statusResult =
        await provider.getTransactionStatus("vf_voucher_e2e");
      expect(statusResult.status).toBe("completed");
    });

    it("handles a failed collection gracefully", async () => {
      fakeClient.post.mockRejectedValue({ response: { status: 503 } });

      const result = await provider.requestPayment("233241234567", "150");

      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
    });
  });
});
