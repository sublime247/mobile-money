import { AirtelService } from "../../src/services/mobilemoney/providers/airtel";

jest.mock("axios");
jest.mock("fs");

describe("AirtelService - Additional Session Proxy Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AIRTEL_MODE;
    delete process.env.AIRTEL_PROXY_URL;
    delete process.env.AIRTEL_WEB_BASE_URL;
    delete process.env.AIRTEL_USERNAME;
    delete process.env.AIRTEL_SESSION_STORE_PATH;
    delete process.env.AIRTEL_COUNTRY;
    delete process.env.AIRTEL_CURRENCY;
    delete process.env.AIRTEL_API_KEY;
    delete process.env.AIRTEL_API_SECRET;
    delete process.env.AIRTEL_CURRENCY_KE;
  });

  describe("Session expiry and refresh", () => {
    it("should force re-login when session is expired", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };
      const now = 1000000;

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        sessionTtlMs: 5000,
        clock: () => now,
        username: "user",
        password: "pass",
      });

      (service as any).session = {
        cookies: { sid: { value: "expired" } },
        csrfToken: "old",
        expiresAt: now - 1000,
        authenticatedAt: now - 10000,
      };

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: "<html><input name='_csrf' value='new-csrf'/></html>",
        headers: { "set-cookie": ["sid=fresh; Path=/"] },
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: { "set-cookie": ["sid=logged-in; Path=/"] },
      });

      mockClient.post.mockResolvedValueOnce({
        status: 200,
        data: { transaction: { id: "tx1" } },
        headers: {},
      });

      const result = await service.sendPayout("2348012345678", "500");

      expect(result.success).toBe(true);
      expect(mockClient.get).toHaveBeenCalledWith("/login", expect.anything());
    });

    it("should deduplicate concurrent login promises", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        username: "user",
        password: "pass",
      });

      mockClient.get = jest.fn().mockResolvedValue({
        status: 200,
        data: "",
        headers: { "set-cookie": ["sid=abc; Path=/"] },
      });

      mockClient.post = jest.fn().mockResolvedValue({
        status: 200,
        data: { success: true },
        headers: { "set-cookie": ["sid=abc; Path=/"] },
      });

      const [result1, result2] = await Promise.all([
        service.sendPayout("2348012345678", "100"),
        service.sendPayout("2348012345679", "200"),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      const loginCalls = mockClient.get.mock.calls.filter(
        (c) => c[0] === "/login",
      );
      expect(loginCalls.length).toBe(1);
    });

    it("should anchor fallback expiry to successful login time", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };
      let now = 1000000;
      const sessionTtlMs = 5000;

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        sessionTtlMs,
        clock: () => now,
        username: "user",
        password: "pass",
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: "<html><input name='_csrf' value='csrf-token'/></html>",
        headers: { "set-cookie": ["sid=prelogin; Path=/"] },
      });

      mockClient.post = jest
        .fn()
        .mockImplementationOnce(async () => {
          now += 2000;
          return {
            status: 200,
            data: { success: true },
            headers: { "set-cookie": ["sid=logged-in; Path=/"] },
          };
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { transaction: { id: "tx-login" } },
          headers: {},
        });

      const result = await service.sendPayout("2348012345678", "500");

      expect(result.success).toBe(true);
      expect(service["session"]).toEqual(
        expect.objectContaining({
          expiresAt: now + sessionTtlMs,
          authenticatedAt: now,
        }),
      );
    });

    it("should not extend cached session expiry on ordinary requests", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };
      const now = 1000000;
      const expiresAt = now + 300000;
      const authenticatedAt = now - 10000;

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        refreshSkewMs: 60000,
        clock: () => now,
        username: "user",
        password: "pass",
      });

      (service as any).session = {
        cookies: { sid: { value: "cached" } },
        csrfToken: "csrf-token",
        expiresAt,
        authenticatedAt,
      };

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { transaction: { id: "tx-existing-session" } },
        headers: { "set-cookie": ["sid=updated; Path=/"] },
      });

      const result = await service.sendPayout("2348012345678", "500");

      expect(result.success).toBe(true);
      expect(service["session"]).toEqual(
        expect.objectContaining({
          expiresAt,
          authenticatedAt,
        }),
      );
      expect(mockClient.get).not.toHaveBeenCalled();
    });

    it("should return a controlled error for null web balance responses", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };
      const now = 1000000;

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        clock: () => now,
        username: "user",
        password: "pass",
      });

      (service as any).session = {
        cookies: { sid: { value: "cached" } },
        csrfToken: "csrf-token",
        expiresAt: now + 300000,
        authenticatedAt: now - 10000,
      };

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: null,
        headers: {},
      });

      const result = await service.getOperationalBalance();

      expect(result.success).toBe(false);
      expect((result.error as Error).message).toBe(
        "Airtel balance response body was empty",
      );
    });
  });

  describe("East Africa currency validation", () => {
    it("should accept correct currency for Kenya", () => {
      const service = new AirtelService({
        mode: "direct",
        directHttpClient: { post: jest.fn() },
        country: "KE",
        currency: "KES",
      });

      expect((service as any).currency).toBe("KES");
      expect((service as any).countryCode).toBe("KE");
    });

    it("should reject payment for mismatched Kenya currency", async () => {
      const service = new AirtelService({
        mode: "direct",
        directHttpClient: { post: jest.fn() },
        country: "KE",
        currency: "NGN",
      });

      await expect(
        service.requestPayment("254700000000", "1000"),
      ).resolves.toMatchObject({
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining('country "KE" requires currency "KES"'),
        }),
      });
    });

    it("should accept correct currency for Tanzania", () => {
      const service = new AirtelService({
        mode: "direct",
        directHttpClient: { post: jest.fn() },
        country: "TZ",
        currency: "TZS",
      });

      expect((service as any).currency).toBe("TZS");
    });

    it("should accept correct currency for Uganda", () => {
      const service = new AirtelService({
        mode: "direct",
        directHttpClient: { post: jest.fn() },
        country: "UG",
        currency: "UGX",
      });

      expect((service as any).currency).toBe("UGX");
    });

    it("should use default currency for non-East-Africa country", () => {
      const service = new AirtelService({
        mode: "direct",
        directHttpClient: { post: jest.fn() },
        country: "NG",
      });

      expect((service as any).currency).toBe("NGN");
    });

    it("should resolve currency from environment variable", () => {
      process.env.AIRTEL_CURRENCY_KE = "KES";

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: { post: jest.fn() },
        country: "KE",
      });

      expect((service as any).currency).toBe("KES");
    });
  });

  describe("Error handling and retry logic", () => {
    it("should retry on 500 errors in direct mode", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
        maxAttempts: 3,
      });

      mockClient.post = jest
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "token", expires_in: 3600 },
        })
        .mockResolvedValueOnce({ status: 500, data: { error: "server error" } })
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "token2", expires_in: 3600 },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { success: true },
        });

      const result = await service.sendPayout("2348012345678", "1000");

      expect(result.success).toBe(true);
    });

    it("should fail after max retries exhausted", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
        maxAttempts: 2,
      });

      mockClient.post = jest
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "token", expires_in: 3600 },
        })
        .mockResolvedValueOnce({ status: 500, data: { error: "server error" } })
        .mockResolvedValue({ status: 500, data: { error: "server error" } });

      const result = await service.sendPayout("2348012345678", "1000");

      expect(result.success).toBe(false);
    });

    it("should handle connection timeout gracefully", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
        maxAttempts: 2,
      });

      mockClient.post = jest
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "token", expires_in: 3600 },
        })
        .mockRejectedValueOnce({ code: "ECONNABORTED", message: "timeout" })
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "token2", expires_in: 3600 },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { success: true },
        });

      const result = await service.sendPayout("2348012345678", "1000");

      expect(result.success).toBe(true);
    });

    it("should handle proxy client not configured error", async () => {
      const service = new AirtelService({
        mode: "proxy",
      });

      await expect(
        service.sendPayout("2348012345678", "1000"),
      ).resolves.toMatchObject({
        success: false,
        error: expect.objectContaining({ message: "Proxy client not configured" }),
      });
    });
  });

  describe("Balance response parsing", () => {
    it("should parse balance from data.balance (flat structure)", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { access_token: "token", expires_in: 3600 },
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { balance: 25000, currency: "NGN" },
      });

      const result = await service.getOperationalBalance();

      expect(result.success).toBe(true);
      expect(result.data?.availableBalance).toBe(25000);
    });

    it("should parse balance as string number", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { access_token: "token", expires_in: 3600 },
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: {
          data: { availableBalance: "75000.50", currency: "KES" },
        },
      });

      const result = await service.getOperationalBalance();

      expect(result.success).toBe(true);
      expect(result.data?.availableBalance).toBe(75000.5);
    });

    it("should handle balance response with no balance field", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { access_token: "token", expires_in: 3600 },
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: {},
      });

      const result = await service.getOperationalBalance();

      expect(result.success).toBe(true);
      expect(result.data?.availableBalance).toBe(0);
    });

    it("should return a controlled error for null direct balance responses", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { access_token: "token", expires_in: 3600 },
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: null,
      });

      const result = await service.getOperationalBalance();

      expect(result.success).toBe(false);
      expect((result.error as Error).message).toBe(
        "Airtel balance response body was empty",
      );
    });

    it("should handle non-finite balance values", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { access_token: "token", expires_in: 3600 },
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: {
          data: { availableBalance: "not_a_number", currency: "NGN" },
        },
      });

      const result = await service.getOperationalBalance();

      expect(result.success).toBe(false);
    });
  });

  describe("Cookie serialization edge cases", () => {
    it("should serialize multiple cookies from session", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        username: "user",
        password: "pass",
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: "",
        headers: {
          "set-cookie": [
            "sessionid=abc123; Path=/",
            "csrf=xyz789; Path=/",
            "lang=en; Path=/; Max-Age=86400",
          ],
        },
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: { "set-cookie": ["sessionid=new; Path=/"] },
      });

      await service.sendPayout("2348012345678", "1000");

      const postCall = mockClient.post.mock.calls.find(
        (c) => c[0] === "/login",
      );
      expect(postCall?.[2]?.headers?.Cookie).toContain("sessionid=abc123");
      expect(postCall?.[2]?.headers?.Cookie).toContain("csrf=xyz789");
    });

    it("should handle set-cookie as a single string (non-array)", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        username: "user",
        password: "pass",
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: "",
        headers: {
          "set-cookie": "sessionid=single; Path=/",
        },
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: {},
      });

      await service.sendPayout("2348012345678", "1000");

      const postCall = mockClient.post.mock.calls.find(
        (c) => c[0] === "/login",
      );
      expect(postCall?.[2]?.headers?.Cookie).toContain("sessionid=single");
    });
  });

  describe("Direct mode token expiry", () => {
    it("should fail gracefully when direct auth body is null", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest.fn().mockResolvedValue({
        status: 200,
        data: null,
      });

      await expect(
        service.sendPayout("2348012345678", "1000"),
      ).resolves.toMatchObject({
        success: false,
        error: expect.objectContaining({
          message: "Airtel direct auth did not return access_token",
        }),
      });
    });

    it("should refresh token when expired", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };
      const now = 1000000;

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
        clock: () => now,
      });

      (service as any).token = "expired-token";
      (service as any).tokenExpiry = now - 1000;

      mockClient.post = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "fresh-token", expires_in: 3600 },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { success: true },
        });

      const result = await service.sendPayout("2348012345678", "1000");

      expect(result.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith(
        "/auth/oauth2/token",
        {},
        expect.anything(),
      );
    });

    it("should reuse valid token without re-authenticating", async () => {
      const mockClient = {
        post: jest.fn()
          .mockResolvedValueOnce({ status: 200, data: { access_token: "token", expires_in: 3600 } })
          .mockResolvedValue({ status: 200, data: { success: true } }),
        get: jest.fn(),
      };
      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      expect((await service.sendPayout("2348012345678", "1000")).success).toBe(true);
      expect((await service.sendPayout("2348012345678", "1000")).success).toBe(true);
      expect(mockClient.post.mock.calls.filter(([url]) => url === "/auth/oauth2/token")).toHaveLength(1);
    });
  });

  describe("Transaction status edge cases", () => {
    it("should map TP status to pending", async () => {
      const mockClient = { get: jest.fn(), post: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { access_token: "token", expires_in: 3600 },
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { data: { transaction: { status: "TP" } } },
      });

      const result = await service.getTransactionStatus("AIRTEL-123");

      expect(result.status).toBe("pending");
    });

    it("should handle status check failure gracefully", async () => {
      const mockClient = { get: jest.fn(), post: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { access_token: "token", expires_in: 3600 },
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 404,
        data: { error: "not found" },
      });

      const result = await service.getTransactionStatus("AIRTEL-123");

      expect(result.status).toBe("unknown");
    });
  });

  describe("requestPayment edge cases", () => {
    it("should return success with provider response time", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "token", expires_in: 3600 },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { transaction: { id: "tx123", status: "TS" } },
        });

      const result = await service.requestPayment("2348012345678", "5000");

      expect(result.success).toBe(true);
      expect(result.providerResponseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should handle payment failure without throwing", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "token", expires_in: 3600 },
        })
        .mockResolvedValueOnce({
          status: 400,
          data: { error: "invalid_request" },
        });

      const result = await service.requestPayment("2348012345678", "5000");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("Configuration edge cases", () => {
    it("should default to Nigeria when no country specified", () => {
      const service = new AirtelService({
        mode: "direct",
        directHttpClient: { post: jest.fn() },
      });

      expect((service as any).countryCode).toBe("NG");
      expect((service as any).currency).toBe("NGN");
    });

    it("should resolve country from AIRTEL_COUNTRY env var", () => {
      process.env.AIRTEL_COUNTRY = "KE";

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: { post: jest.fn() },
      });

      expect((service as any).countryCode).toBe("KE");
    });

    it("should prioritize options over environment variables", () => {
      process.env.AIRTEL_COUNTRY = "NG";

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: { post: jest.fn() },
        country: "TZ",
      });

      expect((service as any).countryCode).toBe("TZ");
    });

    it("should construct correct payment path with country prefix", () => {
      const service = new AirtelService({
        mode: "direct",
        directHttpClient: { post: jest.fn() },
        country: "KE",
      });

      expect((service as any).config.paymentPath).toContain("/ke/");
    });
  });
});
