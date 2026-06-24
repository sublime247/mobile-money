/**
 * Unit tests for Airtel Money Web Session Proxy Wrapper
 *
 * Tests three operating modes:
 * 1. DIRECT: OAuth2 bearer token authentication (default)
 * 2. WEB: Web-based session login with cookie persistence
 * 3. PROXY: External proxy wrapper for session handling
 */

import { AirtelService } from "../../src/services/mobilemoney/providers/airtel";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";

jest.mock("axios");
jest.mock("fs");

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFs = fs as jest.Mocked<typeof fs>;

// Helper to create mock Axios instance
const createMockAxios = () => ({
  create: jest.fn((config) => ({
    request: jest.fn(),
    get: jest.fn(),
    post: jest.fn(),
  })),
});

describe("AirtelService - Session Proxy Wrapper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment variables
    delete process.env.AIRTEL_MODE;
    delete process.env.AIRTEL_PROXY_URL;
    delete process.env.AIRTEL_WEB_BASE_URL;
    delete process.env.AIRTEL_USERNAME;
    delete process.env.AIRTEL_SESSION_STORE_PATH;
  });

  // =========================================================================
  // DIRECT MODE TESTS
  // =========================================================================

  describe("DIRECT mode (OAuth2)", () => {
    it("should use Bearer token authentication for payouts", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };
      const mockResponse = {
        status: 200,
        data: { success: true },
        headers: {},
      };

      const service = new AirtelService({
        mode: "direct",
        httpClient: mockClient,
        directHttpClient: mockClient,
      });

      mockClient.post = jest
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "test-token", expires_in: 3600 },
        })
        .mockResolvedValueOnce(mockResponse);

      const result = await service.sendPayout("2348012345678", "1000");

      expect(result.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith(
        "/auth/oauth2/token",
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
          }),
        }),
      );
    });

    it("should retry on 401 after clearing token", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
        maxAttempts: 2,
      });

      // First auth succeeds, first request fails with 401, second auth, second request succeeds
      mockClient.post = jest
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "token1", expires_in: 3600 },
        })
        .mockResolvedValueOnce({ status: 401, data: { error: "unauthorized" } })
        .mockResolvedValueOnce({
          status: 200,
          data: { access_token: "token2", expires_in: 3600 },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { success: true },
        });

      const result = await service.sendPayout("2348012345678", "1000");

      // Should succeed after retry
      expect(result.success).toBe(true);
    });

    it("should retrieve balance via Bearer token", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "direct",
        directHttpClient: mockClient,
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { access_token: "test-token", expires_in: 3600 },
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: {
          data: { availableBalance: 50000, currency: "NGN" },
        },
      });

      const result = await service.getOperationalBalance();

      expect(result.success).toBe(true);
      expect(result.data?.availableBalance).toBe(50000);
    });
  });

  // =========================================================================
  // WEB SESSION MODE TESTS
  // =========================================================================

  describe("WEB mode (Session-based)", () => {
    it("should login and extract cookies from response", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        clock: () => 1000000,
      });

      // Mock login page GET
      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: "<html><input name='_csrf' value='csrf-token-123'/></html>",
        headers: { "set-cookie": ["sessionid=abc123; Path=/"] },
      });

      // Mock login POST
      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: { "set-cookie": ["sessionid=xyz789; Path=/"] },
      });

      const result = await service.sendPayout("2348012345678", "1000");

      expect(mockClient.get).toHaveBeenCalledWith("/login", expect.anything());
      expect(mockClient.post).toHaveBeenCalledWith(
        "/login",
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Cookie: expect.stringContaining("sessionid="),
          }),
        }),
      );
    });

    it("should extract CSRF token from response headers", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: "",
        headers: { "x-csrf-token": "header-csrf-123" },
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: {},
      });

      await service.sendPayout("2348012345678", "1000");

      // Verify CSRF header was sent
      expect(mockClient.post).toHaveBeenCalledWith(
        "/login",
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-CSRF-Token": "header-csrf-123",
          }),
        }),
      );
    });

    it("should persist and reload session from file", async () => {
      const sessionPath = ".airtel-session/session.json";
      const mockClient = { post: jest.fn(), get: jest.fn() };
      const mockNow = 1000000;

      mockedFs.existsSync = jest.fn().mockReturnValue(true);
      mockedFs.mkdirSync = jest.fn();
      mockedFs.writeFileSync = jest.fn();
      mockedFs.readFileSync = jest.fn(() => {
        return JSON.stringify({
          cookies: { sessionid: { value: "cached-session" } },
          csrfToken: "cached-csrf",
          expiresAt: mockNow + 1000000,
          authenticatedAt: mockNow,
        });
      });

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        sessionStorePath: sessionPath,
        clock: () => mockNow,
      });

      // Session should be loaded from file, no login needed
      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: {},
      });

      const result = await service.sendPayout("2348012345678", "1000");

      expect(result.success).toBe(true);
      // Login should not have been called since session was cached
      expect(mockClient.get).not.toHaveBeenCalledWith(
        "/login",
        expect.anything(),
      );
    });

    it("should refresh session when approaching expiry", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };
      const mockNow = 1000000;
      const refreshSkew = 60000;

      mockedFs.existsSync = jest.fn().mockReturnValue(true);
      mockedFs.mkdirSync = jest.fn();
      mockedFs.writeFileSync = jest.fn();
      mockedFs.readFileSync = jest.fn(() => {
        return JSON.stringify({
          cookies: { sessionid: { value: "old-session" } },
          csrfToken: "old-csrf",
          expiresAt: mockNow + refreshSkew / 2, // Within refresh skew window
          authenticatedAt: mockNow - 500000,
        });
      });

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        sessionStorePath: ".airtel-session/session.json",
        refreshSkewMs: refreshSkew,
        clock: () => mockNow,
      });

      // Mock refresh endpoint
      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: { "set-cookie": ["sessionid=refreshed; Path=/"] },
      });

      const result = await service.sendPayout("2348012345678", "1000");

      expect(result.success).toBe(true);
      // Refresh should have been called
      expect(mockClient.post).toHaveBeenCalledWith(
        "/session/refresh",
        expect.anything(),
        expect.anything(),
      );
    });

    it("should login again on session expiration response (401)", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
        maxAttempts: 2,
      });

      // First attempt returns 401
      // Second attempt triggers full login
      mockClient.post = jest
        .fn()
        .mockResolvedValueOnce({
          status: 401,
          data: { error: "session expired" },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: "",
          headers: { "set-cookie": ["sessionid=new; Path=/"] },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { success: true },
          headers: {},
        });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: "",
        headers: {},
      });

      const result = await service.sendPayout("2348012345678", "1000");

      expect(result.success).toBe(true);
    });

    it("should send Idempotency-Key header for payments", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: "",
        headers: {},
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: {},
      });

      await service.sendPayout("2348012345678", "1000");

      // Check that Idempotency-Key was sent
      const paymentCall = mockClient.post.mock.calls.find(
        (call) => call[0] === "/standard/v1/disbursements/",
      );
      expect(paymentCall?.[2]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            "Idempotency-Key": expect.stringMatching(/^AIRTEL-/),
          }),
        }),
      );
    });
  });

  // =========================================================================
  // PROXY MODE TESTS
  // =========================================================================

  describe("PROXY mode", () => {
    it("should forward payout to proxy endpoint with secret header", async () => {
      const mockClient = { post: jest.fn() };

      const service = new AirtelService({
        mode: "proxy",
        proxyHttpClient: mockClient,
        proxySecret: "my-proxy-secret",
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { transaction: { id: "tx123", status: "TS" } },
        headers: {},
      });

      const result = await service.sendPayout("2348012345678", "5000");

      expect(result.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith(
        "/standard/v1/disbursements/",
        expect.objectContaining({
          payee: { msisdn: "2348012345678" },
          transaction: { amount: 5000, id: expect.any(String) },
        }),
        expect.objectContaining({
          headers: {
            "X-Airtel-Proxy-Secret": "my-proxy-secret",
          },
        }),
      );
    });

    it("should forward payment collection to proxy endpoint", async () => {
      const mockClient = { post: jest.fn() };

      const service = new AirtelService({
        mode: "proxy",
        proxyHttpClient: mockClient,
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { transaction: { id: "tx123" } },
        headers: {},
      });

      const result = await service.requestPayment("2348012345678", "2000");

      expect(result.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith(
        "/merchant/v1/payments/",
        expect.objectContaining({
          subscriber: { msisdn: "2348012345678" },
        }),
        expect.anything(),
      );
    });

    it("should forward status check to proxy endpoint", async () => {
      const mockClient = { get: jest.fn() };

      const service = new AirtelService({
        mode: "proxy",
        proxyHttpClient: mockClient,
        proxySecret: "secret123",
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: {
          data: {
            transaction: { status: "TS", id: "tx123" },
          },
        },
        headers: {},
      });

      const result = await service.checkStatus("AIRTEL-1234567890");

      expect(result.success).toBe(true);
      expect(mockClient.get).toHaveBeenCalledWith(
        "/standard/v1/payments/AIRTEL-1234567890",
        expect.objectContaining({
          headers: {
            "X-Airtel-Proxy-Secret": "secret123",
          },
        }),
      );
    });

    it("should forward balance query to proxy endpoint", async () => {
      const mockClient = { get: jest.fn() };

      const service = new AirtelService({
        mode: "proxy",
        proxyHttpClient: mockClient,
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: {
          data: { availableBalance: 100000, currency: "NGN" },
        },
        headers: {},
      });

      const result = await service.getOperationalBalance();

      expect(result.success).toBe(true);
      expect(result.data?.availableBalance).toBe(100000);
    });

    it("should work without proxy secret if not configured", async () => {
      const mockClient = { post: jest.fn() };

      const service = new AirtelService({
        mode: "proxy",
        proxyHttpClient: mockClient,
        proxySecret: undefined,
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: {},
      });

      await service.sendPayout("2348012345678", "1000");

      const call = mockClient.post.mock.calls[0];
      expect(call[2]?.headers).not.toHaveProperty("X-Airtel-Proxy-Secret");
    });
  });

  // =========================================================================
  // MODE RESOLUTION TESTS
  // =========================================================================

  describe("Mode resolution", () => {
    it("should resolve to PROXY mode when proxyBaseUrl is set", () => {
      const service = new AirtelService({
        mode: "direct",
        proxyBaseUrl: "http://proxy.example.com",
        directHttpClient: { post: jest.fn() },
        proxyHttpClient: { post: jest.fn() },
      });

      // Mode should be proxy regardless of explicit mode setting
      expect((service as any).mode).toBe("proxy");
    });

    it("should resolve to WEB mode when web credentials are provided", () => {
      const service = new AirtelService({
        webBaseUrl: "http://web.example.com",
        username: "user",
        password: "pass",
        httpClient: { get: jest.fn() },
      });

      expect((service as any).mode).toBe("web");
    });

    it("should default to DIRECT mode when no other config provided", () => {
      const service = new AirtelService({
        directHttpClient: { post: jest.fn() },
      });

      expect((service as any).mode).toBe("direct");
    });

    it("should resolve mode from environment variables", () => {
      process.env.AIRTEL_PROXY_URL = "http://proxy.com";

      const service = new AirtelService({
        proxyHttpClient: { post: jest.fn() },
      });

      expect((service as any).mode).toBe("proxy");
    });
  });

  // =========================================================================
  // COOKIE PARSING TESTS
  // =========================================================================

  describe("Cookie parsing and serialization", () => {
    it("should parse Set-Cookie headers with path and expiry", async () => {
      const mockClient = { post: jest.fn(), get: jest.fn() };

      const service = new AirtelService({
        mode: "web",
        httpClient: mockClient,
      });

      mockClient.get = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: "",
        headers: {
          "set-cookie": [
            "sessionid=abc123; Path=/; Expires=Wed, 09 Jun 2025 10:18:14 GMT",
            "user_id=test; Path=/",
          ],
        },
      });

      mockClient.post = jest.fn().mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: {},
      });

      await service.sendPayout("2348012345678", "1000");

      // Verify both cookies were captured
      const postCall = mockClient.post.mock.calls.find(
        (call) => call[0] === "/login",
      );
      expect(postCall?.[2]?.headers?.Cookie).toContain("sessionid=abc123");
      expect(postCall?.[2]?.headers?.Cookie).toContain("user_id=test");
    });
  });

  // =========================================================================
  // TRANSACTION STATUS PARSING
  // =========================================================================

  describe("Transaction status parsing", () => {
    it("should parse TS (completed) status code", async () => {
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
        data: { data: { transaction: { status: "TS" } } },
      });

      const result = await service.getTransactionStatus("AIRTEL-123");

      expect(result.status).toBe("completed");
    });

    it("should parse TF (failed) status code", async () => {
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
        data: { data: { transaction: { status: "TF" } } },
      });

      const result = await service.getTransactionStatus("AIRTEL-123");

      expect(result.status).toBe("failed");
    });

    it("should return unknown for unrecognized status codes", async () => {
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
        data: { data: { transaction: { status: "UNKNOWN" } } },
      });

      const result = await service.getTransactionStatus("AIRTEL-123");

      expect(result.status).toBe("unknown");
    });
  });
});
