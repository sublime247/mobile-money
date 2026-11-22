import {
  AirtelTokenManager,
  AirtelClient,
  calculateJitteredBackoff,
} from "../airtelClient";

describe("Airtel OAuth Token Refresh & Jittered Retry (#2270)", () => {
  describe("calculateJitteredBackoff", () => {
    it("returns values within [0, min(maxDelay, baseDelay * 2^attempt)]", () => {
      const baseDelay = 100;
      const maxDelay = 1000;

      for (let attempt = 0; attempt < 5; attempt++) {
        const expectedMax = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
        for (let i = 0; i < 20; i++) {
          const delay = calculateJitteredBackoff(attempt, baseDelay, maxDelay);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(expectedMax);
        }
      }
    });

    it("respects maxDelay cap", () => {
      const delay = calculateJitteredBackoff(10, 100, 500);
      expect(delay).toBeLessThanOrEqual(500);
    });
  });

  describe("AirtelTokenManager", () => {
    let mockRedis: any;
    let mockHttpClient: any;
    let fakeTime: number;

    beforeEach(() => {
      fakeTime = 1000000;
      mockRedis = {
        store: new Map<string, { value: string; ex: number }>(),
        isOpen: true,
        get: jest.fn(async (key: string) => {
          const item = mockRedis.store.get(key);
          return item ? item.value : null;
        }),
        set: jest.fn(async (key: string, value: string, options?: any) => {
          mockRedis.store.set(key, { value, ex: options?.EX });
          return "OK";
        }),
        del: jest.fn(async (key: string) => {
          mockRedis.store.delete(key);
          return 1;
        }),
      };

      mockHttpClient = {
        post: jest.fn(),
      };
    });

    it("caches access token in Redis with TTL = expires_in - 60s (proactive refresh buffer)", async () => {
      mockHttpClient.post.mockResolvedValueOnce({
        status: 200,
        data: {
          access_token: "token-abc-123",
          expires_in: 3600,
        },
      });

      const manager = new AirtelTokenManager({
        apiKey: "test-key",
        apiSecret: "test-secret",
        redis: mockRedis,
        httpClient: mockHttpClient,
        clock: () => fakeTime,
        proactiveBufferSeconds: 60,
      });

      const token = await manager.getAccessToken();
      expect(token).toBe("token-abc-123");
      expect(mockHttpClient.post).toHaveBeenCalledTimes(1);

      // Verify Redis caching with proactive buffer TTL: 3600 - 60 = 3540s
      expect(mockRedis.set).toHaveBeenCalledWith(
        "airtel:oauth:token:test-key",
        "token-abc-123",
        { EX: 3540 },
      );
    });

    it("refreshes token proactively before expiration rather than waiting for 401", async () => {
      mockHttpClient.post
        .mockResolvedValueOnce({
          status: 200,
          data: {
            access_token: "token-initial",
            expires_in: 300, // 300s
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            access_token: "token-refreshed",
            expires_in: 300,
          },
        });

      const manager = new AirtelTokenManager({
        apiKey: "test-key",
        apiSecret: "test-secret",
        redis: mockRedis,
        httpClient: mockHttpClient,
        clock: () => fakeTime,
        proactiveBufferSeconds: 60,
      });

      // 1. Initial fetch at fakeTime = 1,000,000 (expires at 1,300,000; proactive boundary at 1,240,000)
      const token1 = await manager.getAccessToken();
      expect(token1).toBe("token-initial");
      expect(mockHttpClient.post).toHaveBeenCalledTimes(1);

      // 2. Advance time to 1,100,000 (100s passed, 200s remaining > 60s buffer) -> reuse cached token
      fakeTime += 100 * 1000;
      const token2 = await manager.getAccessToken();
      expect(token2).toBe("token-initial");
      expect(mockHttpClient.post).toHaveBeenCalledTimes(1);

      // 3. Advance time to 1,250,000 (remaining time is 50s, which is within the 60s proactive buffer)
      // Clear Redis mock key to simulate proactive expiry in Redis
      mockRedis.store.clear();
      fakeTime = 1250000;

      const token3 = await manager.getAccessToken();
      expect(token3).toBe("token-refreshed");
      expect(mockHttpClient.post).toHaveBeenCalledTimes(2);
    });

    it("deduplicates concurrent refresh attempts using a single in-flight promise", async () => {
      let resolveHttp: any;
      const httpPromise = new Promise((resolve) => {
        resolveHttp = resolve;
      });

      mockHttpClient.post.mockImplementationOnce(() => httpPromise);

      const manager = new AirtelTokenManager({
        apiKey: "test-key",
        apiSecret: "test-secret",
        redis: mockRedis,
        httpClient: mockHttpClient,
        clock: () => fakeTime,
      });

      // Launch 5 concurrent getAccessToken requests simultaneously
      const pendingCalls = Promise.all([
        manager.getAccessToken(),
        manager.getAccessToken(),
        manager.getAccessToken(),
        manager.getAccessToken(),
        manager.getAccessToken(),
      ]);

      // Resolve the single HTTP request
      resolveHttp({
        status: 200,
        data: {
          access_token: "single-shared-token",
          expires_in: 3600,
        },
      });

      const results = await pendingCalls;

      // Exactly ONE HTTP call was made
      expect(mockHttpClient.post).toHaveBeenCalledTimes(1);
      // All 5 callers received the identical token
      expect(results).toEqual([
        "single-shared-token",
        "single-shared-token",
        "single-shared-token",
        "single-shared-token",
        "single-shared-token",
      ]);
    });

    it("retries on HTTP 429 and server errors with exponential backoff and jitter", async () => {
      const delays: number[] = [];
      const sleepMock = jest.fn(async (ms: number) => {
        delays.push(ms);
      });

      mockHttpClient.post
        .mockResolvedValueOnce({ status: 429, data: "Too Many Requests" })
        .mockResolvedValueOnce({ status: 503, data: "Service Unavailable" })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            access_token: "token-after-retry",
            expires_in: 1800,
          },
        });

      const manager = new AirtelTokenManager({
        apiKey: "test-key",
        apiSecret: "test-secret",
        redis: mockRedis,
        httpClient: mockHttpClient,
        clock: () => fakeTime,
        sleep: sleepMock,
        baseDelayMs: 50,
        maxDelayMs: 400,
      });

      const token = await manager.getAccessToken();
      expect(token).toBe("token-after-retry");
      expect(mockHttpClient.post).toHaveBeenCalledTimes(3);
      expect(sleepMock).toHaveBeenCalledTimes(2);

      // Verify delay calls were made with backoff values <= max for each attempt
      expect(delays[0]).toBeLessThanOrEqual(50); // attempt 0: baseDelay * 2^0 = 50
      expect(delays[1]).toBeLessThanOrEqual(100); // attempt 1: baseDelay * 2^1 = 100
    });
  });

  describe("AirtelClient operations", () => {
    let mockHttpClient: any;
    let mockTokenManager: any;

    beforeEach(() => {
      mockHttpClient = {
        request: jest.fn(),
      };
      mockTokenManager = {
        getAccessToken: jest.fn().mockResolvedValue("bearer-token-xyz"),
        invalidateToken: jest.fn().mockResolvedValue(undefined),
      };
    });

    it("retries on HTTP 429 rate-limited calls with backoff", async () => {
      const delays: number[] = [];
      const sleepMock = jest.fn(async (ms: number) => {
        delays.push(ms);
      });

      mockHttpClient.request
        .mockResolvedValueOnce({
          status: 429,
          data: { error: "Rate limit exceeded" },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            data: { transaction: { id: "tx-1", status: "TS" } },
            status: { success: true },
          },
        });

      const client = new AirtelClient({
        httpClient: mockHttpClient,
        sleep: sleepMock,
        baseDelayMs: 20,
        maxDelayMs: 200,
      });
      (client as any).tokenManager = mockTokenManager;

      const result = await client.requestPayment("+237670000000", "500", "REF-123");
      expect(result.success).toBe(true);
      expect(mockHttpClient.request).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledTimes(1);
    });

    it("invalidates token and re-authenticates when response is 401 Unauthorized", async () => {
      mockHttpClient.request
        .mockResolvedValueOnce({
          status: 401,
          data: { error: "Token expired" },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            data: { transaction: { id: "payout-1", status: "TS" } },
            status: { success: true },
          },
        });

      const client = new AirtelClient({
        httpClient: mockHttpClient,
      });
      (client as any).tokenManager = mockTokenManager;

      const result = await client.sendPayout("+237670000000", "1000", "REF-PAYOUT-1");
      expect(result.success).toBe(true);
      expect(mockTokenManager.invalidateToken).toHaveBeenCalledTimes(1);
      expect(mockHttpClient.request).toHaveBeenCalledTimes(2);
    });
  });
});
