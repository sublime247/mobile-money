import axios from "axios";
import { createHmac } from "crypto";
import { WaveSenegalProvider } from "../../src/services/mobilemoney/providers/waveSenegal";

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

describe("WaveSenegalProvider", () => {
  let fakeClient: ReturnType<typeof makeClient>;
  let provider: WaveSenegalProvider;

  beforeEach(() => {
    jest.resetAllMocks();

    fakeClient = makeClient();
    mockedAxios.create = jest.fn().mockReturnValue(fakeClient);

    process.env.WAVE_API_KEY = "test-wave-api-key";
    process.env.WAVE_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.WAVE_CURRENCY = "XOF";
    process.env.WAVE_BASE_URL = "https://api.wave.com/v1";

    provider = new WaveSenegalProvider();
  });

  afterEach(() => {
    delete process.env.WAVE_API_KEY;
    delete process.env.WAVE_WEBHOOK_SECRET;
    delete process.env.WAVE_CURRENCY;
    delete process.env.WAVE_BASE_URL;
  });

  // ─── Constructor ──────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("creates axios instance with Bearer token auth", () => {
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "https://api.wave.com/v1",
          headers: expect.objectContaining({
            Authorization: "Bearer test-wave-api-key",
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("falls back to default base URL when WAVE_BASE_URL is not set", () => {
      delete process.env.WAVE_BASE_URL;
      new WaveSenegalProvider();
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "https://api.wave.com/v1" }),
      );
    });
  });

  // ─── requestPayment ───────────────────────────────────────────────────────

  describe("requestPayment", () => {
    const mockSession = {
      id: "cs_123",
      status: "pending",
      wave_launch_url: "https://wave.com/checkout/cs_123",
      client_reference: "WAVE-PAY-1234",
    };

    it("returns success with checkout session data", async () => {
      fakeClient.post.mockResolvedValue({ data: mockSession });

      const result = await provider.requestPayment("221771234567", "5000");

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockSession);
    });

    it("posts to /checkout/sessions endpoint", async () => {
      fakeClient.post.mockResolvedValue({ data: mockSession });

      await provider.requestPayment("221771234567", "5000");

      expect(fakeClient.post).toHaveBeenCalledWith(
        "/checkout/sessions",
        expect.objectContaining({
          amount: "5000",
          currency: "XOF",
          recipient_mobile_number: "221771234567",
        }),
      );
    });

    it("serializes amount as a string in the payload", async () => {
      fakeClient.post.mockResolvedValue({ data: mockSession });

      await provider.requestPayment("0771234567", "10000");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(typeof body.amount).toBe("string");
      expect(body.amount).toBe("10000");
    });

    it("normalizes phone number (strips leading 0, prepends 221)", async () => {
      fakeClient.post.mockResolvedValue({ data: mockSession });

      await provider.requestPayment("0771234567", "5000");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.recipient_mobile_number).toBe("221771234567");
    });

    it("keeps phone number unchanged when already prefixed with 221", async () => {
      fakeClient.post.mockResolvedValue({ data: mockSession });

      await provider.requestPayment("221771234567", "5000");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.recipient_mobile_number).toBe("221771234567");
    });

    it("includes client_reference in the payload", async () => {
      fakeClient.post.mockResolvedValue({ data: mockSession });

      await provider.requestPayment("221771234567", "5000");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.client_reference).toMatch(/^WAVE-PAY-/);
    });

    it("returns success:false when request throws", async () => {
      const networkError = new Error("Network error");
      fakeClient.post.mockRejectedValue(networkError);

      const result = await provider.requestPayment("221771234567", "5000");

      expect(result.success).toBe(false);
      expect(result.error).toBe(networkError);
    });

    it("does not throw on API error – returns error object", async () => {
      fakeClient.post.mockRejectedValue({ response: { status: 422 } });

      await expect(
        provider.requestPayment("221771234567", "5000"),
      ).resolves.toMatchObject({ success: false });
    });
  });

  // ─── sendPayout ───────────────────────────────────────────────────────────

  describe("sendPayout", () => {
    const mockPayout = { id: "tx_abc", status: "pending" };

    it("returns success with payout data", async () => {
      fakeClient.post.mockResolvedValue({ data: mockPayout });

      const result = await provider.sendPayout("221771234567", "3000");

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockPayout);
    });

    it("posts to /b2c/transfers endpoint", async () => {
      fakeClient.post.mockResolvedValue({ data: mockPayout });

      await provider.sendPayout("221771234567", "3000");

      expect(fakeClient.post).toHaveBeenCalledWith(
        "/b2c/transfers",
        expect.objectContaining({
          receive_amount: "3000",
          currency: "XOF",
          mobile: "221771234567",
        }),
      );
    });

    it("serializes amount as receive_amount string", async () => {
      fakeClient.post.mockResolvedValue({ data: mockPayout });

      await provider.sendPayout("221771234567", "7500");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.receive_amount).toBe("7500");
    });

    it("includes client_reference in the payload", async () => {
      fakeClient.post.mockResolvedValue({ data: mockPayout });

      await provider.sendPayout("221771234567", "3000");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.client_reference).toMatch(/^WAVE-OUT-/);
    });

    it("normalizes phone that starts with +221", async () => {
      fakeClient.post.mockResolvedValue({ data: mockPayout });

      await provider.sendPayout("+221771234567", "3000");

      const [, body] = fakeClient.post.mock.calls[0];
      expect(body.mobile).toBe("221771234567");
    });

    it("returns success:false when request throws", async () => {
      fakeClient.post.mockRejectedValue(new Error("timeout"));

      const result = await provider.sendPayout("221771234567", "3000");

      expect(result.success).toBe(false);
    });
  });

  // ─── getTransactionStatus ─────────────────────────────────────────────────

  describe("getTransactionStatus", () => {
    it.each([
      ["succeeded", "completed"],
      ["complete", "completed"],
      ["failed", "failed"],
      ["error", "failed"],
      ["pending", "pending"],
      ["processing", "pending"],
      ["unknown_state", "unknown"],
      ["", "unknown"],
    ])("maps Wave status '%s' → '%s'", async (waveStatus, expected) => {
      fakeClient.get.mockResolvedValue({ data: { status: waveStatus } });

      const result = await provider.getTransactionStatus("tx_001");

      expect(result.status).toBe(expected);
    });

    it("calls GET /transactions/:id", async () => {
      fakeClient.get.mockResolvedValue({ data: { status: "succeeded" } });

      await provider.getTransactionStatus("tx_001");

      expect(fakeClient.get).toHaveBeenCalledWith("/transactions/tx_001");
    });

    it("URL-encodes the transaction id", async () => {
      fakeClient.get.mockResolvedValue({ data: { status: "succeeded" } });

      await provider.getTransactionStatus("tx/with/slashes");

      expect(fakeClient.get).toHaveBeenCalledWith(
        "/transactions/tx%2Fwith%2Fslashes",
      );
    });

    it("returns unknown when request throws", async () => {
      fakeClient.get.mockRejectedValue(new Error("not found"));

      const result = await provider.getTransactionStatus("tx_bad");

      expect(result.status).toBe("unknown");
    });

    it("returns unknown when status field is absent", async () => {
      fakeClient.get.mockResolvedValue({ data: {} });

      const result = await provider.getTransactionStatus("tx_empty");

      expect(result.status).toBe("unknown");
    });
  });

  // ─── verifyWebhookSignature ───────────────────────────────────────────────

  describe("verifyWebhookSignature", () => {
    const secret = "test-webhook-secret";
    const body = JSON.stringify({ event: "payment.completed", id: "evt_1" });

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
      expect(
        provider.verifyWebhookSignature(body + " tampered", sig),
      ).toBe(false);
    });

    it("returns false for a wrong secret", () => {
      const sig = makeSignature(body, "wrong-secret");
      expect(provider.verifyWebhookSignature(body, sig)).toBe(false);
    });

    it("returns false for a signature without sha256= prefix", () => {
      const rawHex = createHmac("sha256", secret).update(body).digest("hex");
      expect(provider.verifyWebhookSignature(body, rawHex)).toBe(false);
    });

    it("returns false when WAVE_WEBHOOK_SECRET is not configured", () => {
      delete process.env.WAVE_WEBHOOK_SECRET;
      const providerNoSecret = new WaveSenegalProvider();
      const sig = makeSignature(body, secret);

      expect(providerNoSecret.verifyWebhookSignature(body, sig)).toBe(false);
    });

    it("accepts a Buffer body", () => {
      const bufBody = Buffer.from(body);
      const sig = makeSignature(bufBody, secret);

      expect(provider.verifyWebhookSignature(bufBody, sig)).toBe(true);
    });
  });

  // ─── End-to-end mock flow ─────────────────────────────────────────────────

  describe("end-to-end mock flow", () => {
    it("completes a full payment → status check flow", async () => {
      // 1. Initiate payment
      fakeClient.post.mockResolvedValueOnce({
        data: {
          id: "cs_e2e",
          status: "pending",
          wave_launch_url: "https://wave.com/checkout/cs_e2e",
        },
      });

      const paymentResult = await provider.requestPayment(
        "221701234567",
        "15000",
      );
      expect(paymentResult.success).toBe(true);
      expect((paymentResult.data as { id: string }).id).toBe("cs_e2e");

      // 2. Simulate customer completing payment, check status
      fakeClient.get.mockResolvedValueOnce({
        data: { id: "cs_e2e", status: "succeeded" },
      });

      const statusResult = await provider.getTransactionStatus("cs_e2e");
      expect(statusResult.status).toBe("completed");
    });

    it("completes a full payout → status check flow", async () => {
      // 1. Initiate payout
      fakeClient.post.mockResolvedValueOnce({
        data: { id: "tx_payout_1", status: "pending" },
      });

      const payoutResult = await provider.sendPayout("221701234567", "8000");
      expect(payoutResult.success).toBe(true);

      // 2. Check payout status
      fakeClient.get.mockResolvedValueOnce({
        data: { id: "tx_payout_1", status: "succeeded" },
      });

      const statusResult =
        await provider.getTransactionStatus("tx_payout_1");
      expect(statusResult.status).toBe("completed");
    });

    it("handles a failed payment gracefully", async () => {
      fakeClient.post.mockRejectedValue({ response: { status: 503 } });

      const result = await provider.requestPayment("221701234567", "15000");

      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
    });
  });
});
