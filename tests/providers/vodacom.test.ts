import axios from "axios";
import crypto from "crypto";
import { VodacomProvider } from "../../src/services/mobilemoney/providers/vodacom";
import { MobileMoneyService } from "../../src/services/mobilemoney/mobileMoneyService";

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock crypto.publicEncrypt to bypass Node.js privateDecrypt security restrictions
jest.mock("crypto", () => {
  const originalCrypto = jest.requireActual("crypto");
  return {
    ...originalCrypto,
    publicEncrypt: jest.fn().mockImplementation((options: any, buffer: Buffer) => {
      return Buffer.from(`mock-encrypted:${buffer.toString()}`);
    })
  };
});

describe("VodacomProvider", () => {
  let provider: VodacomProvider;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.VODACOM_API_KEY = "test-api-key";
    process.env.VODACOM_PUBLIC_KEY = "mock-public-key-pem";
    process.env.VODACOM_SERVICE_PROVIDER_CODE = "123456";
    process.env.VODACOM_BASE_URL = "https://sandbox.openapi.m-pesa.com";
    process.env.VODACOM_MARKET = "vodacomTZN";
    process.env.VODACOM_CURRENCY = "TZS";

    provider = new VodacomProvider();
  });

  describe("Authentication Flow", () => {
    it("should fetch and encrypt getSession auth key correctly", async () => {
      const mockClient = {
        get: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-0",
            output_ResponseDesc: "Request processed successfully",
            output_SessionID: "mock-session-id"
          }
        }),
        post: jest.fn()
      };
      mockedAxios.create.mockReturnValue(mockClient as any);

      provider = new VodacomProvider();

      const token = await (provider as any).getAccessToken();

      expect(token).toBe("mock-session-id");
      expect(mockClient.get).toHaveBeenCalledWith(
        "/vodacomTZN/getSession/",
        expect.any(Object)
      );

      const authHeader = mockClient.get.mock.calls[0][1].headers.Authorization;
      expect(authHeader).toMatch(/^Bearer /);

      const encryptedValue = authHeader.split(" ")[1];
      const decrypted = Buffer.from(encryptedValue, "base64").toString();
      expect(decrypted).toBe("mock-encrypted:test-api-key");
    });
  });

  describe("requestPayment (C2B)", () => {
    it("should request payment successfully", async () => {
      const mockClient = {
        get: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-0",
            output_SessionID: "mock-session-id"
          }
        }),
        post: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-0",
            output_ResponseDesc: "Success",
            output_TransactionID: "TXN12345"
          }
        })
      };
      mockedAxios.create.mockReturnValue(mockClient as any);
      provider = new VodacomProvider();

      const result = await provider.requestPayment("255700000000", "1000");

      expect(result.success).toBe(true);
      expect(result.data.output_TransactionID).toBe("TXN12345");
      expect(mockClient.post).toHaveBeenCalledWith(
        "/vodacomTZN/c2bPayment/singleStage/",
        expect.objectContaining({
          input_Amount: "1000",
          input_CustomerMSISDN: "255700000000",
          input_ServiceProviderCode: "123456"
        }),
        expect.any(Object)
      );

      const authHeader = mockClient.post.mock.calls[0][2].headers.Authorization;
      const encryptedValue = authHeader.split(" ")[1];
      const decrypted = Buffer.from(encryptedValue, "base64").toString();
      expect(decrypted).toBe("mock-encrypted:mock-session-id");
    });

    it("should handle payment failure gracefully without throwing", async () => {
      const mockClient = {
        get: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-0",
            output_SessionID: "mock-session-id"
          }
        }),
        post: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-1",
            output_ResponseDesc: "Insufficient Balance"
          }
        })
      };
      mockedAxios.create.mockReturnValue(mockClient as any);
      provider = new VodacomProvider();

      const result = await provider.requestPayment("255700000000", "1000");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("sendPayout (B2C)", () => {
    it("should execute payout successfully", async () => {
      const mockClient = {
        get: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-0",
            output_SessionID: "mock-session-id"
          }
        }),
        post: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-0",
            output_ResponseDesc: "Success",
            output_TransactionID: "TXN54321"
          }
        })
      };
      mockedAxios.create.mockReturnValue(mockClient as any);
      provider = new VodacomProvider();

      const result = await provider.sendPayout("255700000000", "500");
      expect(result.success).toBe(true);
      expect(result.data.output_TransactionID).toBe("TXN54321");
      expect(mockClient.post).toHaveBeenCalledWith(
        "/vodacomTZN/b2cPayment/singleStage/",
        expect.objectContaining({
          input_Amount: "500",
          input_CustomerMSISDN: "255700000000",
          input_ServiceProviderCode: "123456"
        }),
        expect.any(Object)
      );
    });
  });

  describe("getTransactionStatus", () => {
    it("should query status and map properly", async () => {
      const mockClient = {
        get: jest.fn()
          .mockResolvedValueOnce({
            data: {
              output_ResponseCode: "INS-0",
              output_SessionID: "mock-session-id"
            }
          })
          .mockResolvedValueOnce({
            data: {
              output_ResponseCode: "INS-0",
              output_TransactionStatus: "SUCCESSFUL"
            }
          })
      };
      mockedAxios.create.mockReturnValue(mockClient as any);
      provider = new VodacomProvider();

      const statusResult = await provider.getTransactionStatus("TXN12345");
      expect(statusResult).toEqual({ status: "completed" });
    });
  });

  describe("MobileMoneyService Integration (Lazy Loading Factory)", () => {
    it("should lazy load VodacomProvider through loadProvider factory", async () => {
      const mockClient = {
        get: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-0",
            output_SessionID: "mock-session-id"
          }
        }),
        post: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-0",
            output_ResponseDesc: "Success",
            output_TransactionID: "TXN-LAZY"
          }
        })
      };
      
      // Use active axios instance from the reloaded module registry after resetModules()
      const activeAxios = require("axios") as jest.Mocked<typeof axios>;
      activeAxios.create.mockReturnValue(mockClient as any);

      const service = new MobileMoneyService();

      const result = await service.initiatePayment("vodacom", "255700000000", "1000");

      expect(result.success).toBe(true);
      expect(result.data.output_TransactionID).toBe("TXN-LAZY");
    });
  });

  describe("Circuit Breaker", () => {
    it("should start in closed state", () => {
      const status = provider.getCircuitBreakerStatus();
      expect(status.state).toBe("closed");
      expect(status.failureCount).toBe(0);
    });

    it("should open circuit after failure threshold", async () => {
      const mockClient = {
        get: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-0",
            output_ResponseDesc: "Success",
            output_SessionID: "mock-session",
          },
        }),
        post: jest.fn().mockRejectedValue(new Error("Network error")),
      };
      mockedAxios.create.mockReturnValue(mockClient as any);
      provider = new VodacomProvider();

      // Trigger failures up to threshold (default 5)
      for (let i = 0; i < 5; i++) {
        await provider.requestPayment("255750000000", "1000");
      }

      const status = provider.getCircuitBreakerStatus();
      expect(status.state).toBe("open");
      expect(status.failureCount).toBe(5);
    });

    it("should reject requests when circuit is open", async () => {
      const mockClient = {
        get: jest.fn().mockResolvedValue({
          data: {
            output_ResponseCode: "INS-0",
            output_ResponseDesc: "Success",
            output_SessionID: "mock-session",
          },
        }),
        post: jest.fn().mockRejectedValue(new Error("Network error")),
      };
      mockedAxios.create.mockReturnValue(mockClient as any);
      provider = new VodacomProvider();

      // Open the circuit
      for (let i = 0; i < 5; i++) {
        await provider.requestPayment("255750000000", "1000");
      }

      // Next request should be rejected without calling API
      mockClient.post.mockClear();
      const result = await provider.requestPayment("255750000000", "1000");

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Circuit breaker open");
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it("should expose circuit breaker config from env vars", () => {
      process.env.VODACOM_CB_FAILURE_THRESHOLD = "3";
      process.env.VODACOM_CB_RESET_TIMEOUT_MS = "30000";
      process.env.VODACOM_CB_HALF_OPEN_MAX = "2";

      const customProvider = new VodacomProvider();
      const status = customProvider.getCircuitBreakerStatus();

      expect(status.config.failureThreshold).toBe(3);
      expect(status.config.resetTimeoutMs).toBe(30000);
      expect(status.config.halfOpenMaxAttempts).toBe(2);

      delete process.env.VODACOM_CB_FAILURE_THRESHOLD;
      delete process.env.VODACOM_CB_RESET_TIMEOUT_MS;
      delete process.env.VODACOM_CB_HALF_OPEN_MAX;
    });
  });
});
