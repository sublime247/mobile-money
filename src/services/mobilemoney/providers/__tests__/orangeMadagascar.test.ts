import axios from "axios";
import { createHmac } from "crypto";
import { OrangeMadagascarProvider } from "../orangeMadagascar";

jest.mock("axios");

const axiosMock = axios as jest.Mocked<typeof axios>;

const env = { ...process.env };

function mockTokenRequest() {
  axiosMock.request.mockImplementation(async (config) => {
    if (String(config.url).includes("/oauth/token")) {
      return { data: { access_token: "test-token", expires_in: 3600 }, status: 200 } as any;
    }
    return { data: {}, status: 200 } as any;
  });
}

describe("OrangeMadagascarProvider", () => {
  let provider: OrangeMadagascarProvider;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env };
    process.env.ORANGE_MADAGASCAR_API_KEY = "test-api-key";
    process.env.ORANGE_MADAGASCAR_API_SECRET = "test-api-secret";
    process.env.ORANGE_MADAGASCAR_CALLBACK_SECRET = "test-callback-secret";
    provider = new OrangeMadagascarProvider();
  });

  afterAll(() => {
    process.env = env;
  });

  describe("token caching", () => {
    it("caches the access token and reuses it", async () => {
      let callCount = 0;
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          callCount++;
          return { data: { access_token: "token-1", expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/account/balance")) {
          return { data: { balance: 1000, currency: "MGA" }, status: 200 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      await provider.getOperationalBalance();
      await provider.getOperationalBalance();

      expect(callCount).toBe(1);
    });

    it("refreshes token when expired", async () => {
      let callCount = 0;
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          callCount++;
          return { data: { access_token: `token-${callCount}`, expires_in: 0 }, status: 200 } as any;
        }
        if (String(config.url).includes("/account/balance")) {
          return { data: { balance: 1000, currency: "MGA" }, status: 200 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      await provider.getOperationalBalance();
      await provider.getOperationalBalance();

      expect(callCount).toBe(2);
    });

    it("deduplicates concurrent auth requests", async () => {
      let callCount = 0;
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          callCount++;
          await new Promise((r) => setTimeout(r, 50));
          return { data: { access_token: "token-1", expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/account/balance")) {
          return { data: { balance: 1000, currency: "MGA" }, status: 200 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      await Promise.all([
        provider.getOperationalBalance(),
        provider.getOperationalBalance(),
        provider.getOperationalBalance(),
      ]);

      expect(callCount).toBe(1);
    });
  });

  describe("requestPayment", () => {
    it("returns success on 2xx response", async () => {
      let tokenCalls = 0;
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          tokenCalls++;
          return { data: { access_token: "pay-token", expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/payments/collect")) {
          return { data: { reference: "ref-1", status: "SUCCESSFUL" }, status: 200 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      const result = await provider.requestPayment("+261340000000", "5000");

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(tokenCalls).toBe(1);
    });

    it("returns failure on error response", async () => {
      mockTokenRequest();
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          return { data: { access_token: "token", expires_in: 3600 }, status: 200 } as any;
        }
        return { data: { error: "insufficient_balance" }, status: 402 } as any;
      });

      const result = await provider.requestPayment("+261340000000", "5000");

      expect(result.success).toBe(false);
    });

    it("retries on 401 and refreshes token", async () => {
      let authAttempts = 0;
      let apiAttempts = 0;
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          authAttempts++;
          return { data: { access_token: `token-${authAttempts}`, expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/payments/collect")) {
          apiAttempts++;
          if (apiAttempts === 1) {
            return { data: { error: "unauthorized" }, status: 401 } as any;
          }
          return { data: { reference: "ref-2", status: "SUCCESSFUL" }, status: 200 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      const result = await provider.requestPayment("+261340000000", "5000");

      expect(result.success).toBe(true);
      expect(authAttempts).toBe(2);
      expect(apiAttempts).toBe(2);
    });
  });

  describe("sendPayout", () => {
    it("returns success on 2xx response", async () => {
      mockTokenRequest();
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          return { data: { access_token: "token", expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/payments/disburse")) {
          return { data: { reference: "payout-1", status: "PENDING" }, status: 202 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      const result = await provider.sendPayout("+261340000000", "10000");

      expect(result.success).toBe(true);
    });
  });

  describe("getTransactionStatus", () => {
    it("returns completed for SUCCESSFUL status", async () => {
      mockTokenRequest();
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          return { data: { access_token: "token", expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/payments/ref-1")) {
          return { data: { status: "SUCCESSFUL" }, status: 200 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      const result = await provider.getTransactionStatus("ref-1");

      expect(result.status).toBe("completed");
    });

    it("returns failed for FAILED status", async () => {
      mockTokenRequest();
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          return { data: { access_token: "token", expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/payments/ref-1")) {
          return { data: { status: "FAILED" }, status: 200 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      const result = await provider.getTransactionStatus("ref-1");

      expect(result.status).toBe("failed");
    });

    it("returns pending for PENDING status", async () => {
      mockTokenRequest();
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          return { data: { access_token: "token", expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/payments/ref-1")) {
          return { data: { status: "PENDING" }, status: 200 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      const result = await provider.getTransactionStatus("ref-1");

      expect(result.status).toBe("pending");
    });

    it("returns unknown for unrecognized status", async () => {
      mockTokenRequest();
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          return { data: { access_token: "token", expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/payments/ref-1")) {
          return { data: { status: "UNKNOWN_CODE" }, status: 200 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      const result = await provider.getTransactionStatus("ref-1");

      expect(result.status).toBe("unknown");
    });

    it("returns unknown on error", async () => {
      axiosMock.request.mockRejectedValue(new Error("Network error"));

      const result = await provider.getTransactionStatus("ref-1");

      expect(result.status).toBe("unknown");
    });
  });

  describe("getOperationalBalance", () => {
    it("returns balance data on success", async () => {
      mockTokenRequest();
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          return { data: { access_token: "token", expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/account/balance")) {
          return { data: { balance: 500000, currency: "MGA" }, status: 200 } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      const result = await provider.getOperationalBalance();

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ balance: 500000, currency: "MGA" });
    });

    it("returns failure on error", async () => {
      axiosMock.request.mockRejectedValue(new Error("Network error"));

      const result = await provider.getOperationalBalance();

      expect(result.success).toBe(false);
    });
  });

  describe("sendBatchPayout", () => {
    it("returns empty results for empty items", async () => {
      const result = await provider.sendBatchPayout([]);
      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
    });

    it("rejects batch exceeding max size", async () => {
      const items = Array.from({ length: 51 }, (_, i) => ({
        referenceId: `tx-${i}`,
        phoneNumber: "+261340000000",
        amount: "100",
      }));

      const result = await provider.sendBatchPayout(items);
      expect(result.success).toBe(false);
      expect(result.results.length).toBe(51);
      expect(result.results[0].error).toContain("exceeds maximum");
    });

    it("processes batch and maps results", async () => {
      mockTokenRequest();
      axiosMock.request.mockImplementation(async (config) => {
        if (String(config.url).includes("/oauth/token")) {
          return { data: { access_token: "token", expires_in: 3600 }, status: 200 } as any;
        }
        if (String(config.url).includes("/disburse/batch")) {
          return {
            data: {
              batchId: "BATCH-1",
              items: [
                { referenceId: "tx1", status: "SUCCESSFUL", transactionId: "pmt-1" },
                { referenceId: "tx2", status: "FAILED", errorReason: "blocked", transactionId: "pmt-2" },
              ],
            },
            status: 200,
          } as any;
        }
        return { data: {}, status: 200 } as any;
      });

      const result = await provider.sendBatchPayout([
        { referenceId: "tx1", phoneNumber: "+261340000001", amount: "500" },
        { referenceId: "tx2", phoneNumber: "+261340000002", amount: "1000" },
      ]);

      expect(result.success).toBe(true);
      expect(result.results).toEqual([
        { referenceId: "tx1", success: true, providerReference: "pmt-1" },
        { referenceId: "tx2", success: false, error: "blocked", providerReference: "pmt-2" },
      ]);
    });
  });

  describe("verifyCallbackSignature", () => {
    const secret = "test-callback-secret";
    const payload = JSON.stringify({ reference: "ref-1", status: "SUCCESSFUL" });
    const rawBody = Buffer.from(payload);

    beforeEach(() => {
      process.env.ORANGE_MADAGASCAR_CALLBACK_SECRET = secret;
      provider = new OrangeMadagascarProvider();
    });

    it("returns true for a valid HMAC-SHA256 hex signature", () => {
      const sig = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
      expect(provider.verifyCallbackSignature(rawBody, sig)).toBe(true);
    });

    it("returns true for a valid base64 signature", () => {
      const sig = createHmac("sha256", secret).update(rawBody).digest("base64");
      expect(provider.verifyCallbackSignature(rawBody, sig)).toBe(true);
    });

    it("returns false for a tampered signature", () => {
      const sig = createHmac("sha256", "wrong-secret").update(rawBody).digest("hex");
      expect(provider.verifyCallbackSignature(rawBody, sig)).toBe(false);
    });

    it("returns false when no signature is provided", () => {
      expect(provider.verifyCallbackSignature(rawBody, undefined)).toBe(false);
    });

    it("returns false when signature length differs", () => {
      expect(provider.verifyCallbackSignature(rawBody, "too-short")).toBe(false);
    });

    it("returns false when callback secret is empty", () => {
      process.env.ORANGE_MADAGASCAR_CALLBACK_SECRET = "";
      provider = new OrangeMadagascarProvider();
      const sig = createHmac("sha256", secret).update(rawBody).digest("hex");
      expect(provider.verifyCallbackSignature(rawBody, sig)).toBe(false);
    });
  });

  describe("destroy", () => {
    it("cleans up the prefetch timer", () => {
      provider.destroy();
    });
  });
});
