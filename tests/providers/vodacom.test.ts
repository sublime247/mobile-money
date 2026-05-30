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
});
