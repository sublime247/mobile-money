import axios from "axios";
import { MTNProvider } from "../../src/services/mobilemoney/providers/mtn";

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

function mockAcceptedPayment(response: { data?: object | null }) {
  mockedAxios.post.mockImplementation(async (url) => (
    url.endsWith("/collection/token/")
      ? { data: { access_token: "test-token", expires_in: 3600 }, status: 200 }
      : { ...response, status: 202 }
  ));
}

// Mock environment variables
const originalEnv = process.env;

describe("MTNProvider", () => {
  let provider: MTNProvider;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    // Set up environment variables
    process.env = {
      ...originalEnv,
      MTN_API_KEY: "test-api-key",
      MTN_API_SECRET: "test-api-secret",
      MTN_SUBSCRIPTION_KEY: "test-subscription-key",
    };

    provider = new MTNProvider();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Constructor", () => {
    it("should initialize with environment variables", () => {
      expect(provider).toBeInstanceOf(MTNProvider);
    });

    it("should handle missing environment variables", () => {
      process.env = {
        ...originalEnv,
        MTN_API_KEY: "",
        MTN_API_SECRET: "",
        MTN_SUBSCRIPTION_KEY: "",
      };

      const providerWithoutEnv = new MTNProvider();
      expect(providerWithoutEnv).toBeInstanceOf(MTNProvider);
    });
  });

  describe("requestPayment", () => {
    const phoneNumber = "+256123456789";
    const amount = "1000";

    it("should request payment successfully", async () => {
      const mockResponse = {
        data: {
          referenceId: "test-reference-id",
          status: "PENDING",
        },
      };

      mockAcceptedPayment(mockResponse);

      const result = await provider.requestPayment(phoneNumber, amount);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay",
        {
          amount,
          currency: "XAF",
          externalId: expect.any(String),
          payer: { partyIdType: "MSISDN", partyId: phoneNumber },
          payerMessage: "Payment for Stellar deposit",
          payeeNote: "Deposit",
        },
        {
          headers: {
            Authorization: "Bearer test-token",
            "X-Reference-Id": expect.any(String),
            "Ocp-Apim-Subscription-Key": "test-subscription-key",
            "X-Target-Environment": "sandbox",
          },
        },
      );

      expect(result).toMatchObject({
        success: true,
        data: mockResponse.data,
      });
    });

    it("should handle failed payment request", async () => {
      const mockError = {
        response: {
          data: {
            code: "INSUFFICIENT_FUNDS",
            message: "Insufficient funds in account",
          },
          status: 400,
        },
      };

      mockedAxios.post.mockRejectedValue(mockError);

      const result = await provider.requestPayment(phoneNumber, amount);

      expect(result).toMatchObject({
        success: false,
        error: mockError,
      });
    });

    it("should handle timeout error", async () => {
      const timeoutError = new Error("Request timeout");
      timeoutError.name = "TimeoutError";

      mockedAxios.post.mockRejectedValue(timeoutError);

      const result = await provider.requestPayment(phoneNumber, amount);

      expect(result).toMatchObject({
        success: false,
        error: timeoutError,
      });
    });

    it("should handle invalid credentials error", async () => {
      const authError = {
        response: {
          data: {
            code: "UNAUTHORIZED",
            message: "Invalid API credentials",
          },
          status: 401,
        },
      };

      mockedAxios.post.mockRejectedValue(authError);

      const result = await provider.requestPayment(phoneNumber, amount);

      expect(result).toMatchObject({
        success: false,
        error: authError,
      });
    });

    it("should handle network error", async () => {
      const networkError = new Error("Network error");
      networkError.name = "NetworkError";

      mockedAxios.post.mockRejectedValue(networkError);

      const result = await provider.requestPayment(phoneNumber, amount);

      expect(result).toMatchObject({
        success: false,
        error: networkError,
      });
    });

    it("should handle server error (500)", async () => {
      const serverError = {
        response: {
          data: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Internal server error",
          },
          status: 500,
        },
      };

      mockedAxios.post.mockRejectedValue(serverError);

      const result = await provider.requestPayment(phoneNumber, amount);

      expect(result).toMatchObject({
        success: false,
        error: serverError,
      });
    });

    it("should handle rate limit error", async () => {
      const rateLimitError = {
        response: {
          data: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests",
          },
          status: 429,
        },
      };

      mockedAxios.post.mockRejectedValue(rateLimitError);

      const result = await provider.requestPayment(phoneNumber, amount);

      expect(result).toMatchObject({
        success: false,
        error: rateLimitError,
      });
    });

    it("should generate unique externalId for each request", async () => {
      const mockResponse = { data: { referenceId: "test-ref" } };
      mockAcceptedPayment(mockResponse);

      await provider.requestPayment(phoneNumber, amount);
      const firstCall = mockedAxios.post.mock.calls.find(([url]) => url.endsWith("/requesttopay"))!;
      const firstPayload = firstCall[1] as { externalId: string };

      await provider.requestPayment(phoneNumber, amount);
      const secondCall = mockedAxios.post.mock.calls.filter(([url]) => url.endsWith("/requesttopay"))[1];
      const secondPayload = secondCall[1] as { externalId: string };

      expect(firstPayload.externalId).not.toBe(secondPayload.externalId);
    });

    it("should handle invalid phone number format", async () => {
      const invalidPhone = "invalid-phone";
      const mockResponse = { data: { referenceId: "test-ref" } };
      mockAcceptedPayment(mockResponse);

      const result = await provider.requestPayment(invalidPhone, amount);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          payer: { partyIdType: "MSISDN", partyId: invalidPhone },
        }),
        expect.any(Object),
      );
      expect(result.success).toBe(true);
    });

    it("should handle zero amount", async () => {
      const zeroAmount = "0";
      const mockResponse = { data: { referenceId: "test-ref" } };
      mockAcceptedPayment(mockResponse);

      const result = await provider.requestPayment(phoneNumber, zeroAmount);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          amount: zeroAmount,
        }),
        expect.any(Object),
      );
      expect(result.success).toBe(true);
    });
  });

  describe("sendPayout", () => {
    const phoneNumber = "+256123456789";
    const amount = "1000";

    it("should send payout successfully", async () => {
      const result = await provider.sendPayout(phoneNumber, amount);

      expect(result).toEqual({
        success: true,
      });
    });

    it("should handle payout with different phone numbers", async () => {
      const phoneNumbers = ["+256123456789", "+256987654321", "+256555555555"];

      for (const phone of phoneNumbers) {
        const result = await provider.sendPayout(phone, amount);
        expect(result).toEqual({
          success: true,
        });
      }
    });

    it("should handle payout with different amounts", async () => {
      const amounts = ["100", "1000", "10000"];

      for (const amt of amounts) {
        const result = await provider.sendPayout(phoneNumber, amt);
        expect(result).toEqual({
          success: true,
        });
      }
    });

    it("should handle payout with empty parameters", async () => {
      const result = await provider.sendPayout("", "");
      expect(result).toEqual({
        success: true,
      });
    });
  });

  describe("Authentication Flow", () => {
    it("should use correct API headers for authentication", async () => {
      const mockResponse = { data: { referenceId: "test-ref" } };
      mockAcceptedPayment(mockResponse);

      await provider.requestPayment("+256123456789", "1000");

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        {
          headers: {
            Authorization: "Bearer test-token",
            "X-Reference-Id": expect.any(String),
            "Ocp-Apim-Subscription-Key": "test-subscription-key",
            "X-Target-Environment": "sandbox",
          },
        },
      );
    });

    it("should handle missing subscription key", async () => {
      process.env = {
        ...originalEnv,
        MTN_API_KEY: "test-api-key",
        MTN_API_SECRET: "test-api-secret",
        MTN_SUBSCRIPTION_KEY: "", // Empty subscription key
      };

      const providerWithoutSubKey = new MTNProvider();
      const mockResponse = { data: { referenceId: "test-ref" } };
      mockAcceptedPayment(mockResponse);

      await providerWithoutSubKey.requestPayment("+256123456789", "1000");

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        {
          headers: {
            Authorization: "Bearer test-token",
            "X-Reference-Id": expect.any(String),
            "Ocp-Apim-Subscription-Key": "",
            "X-Target-Environment": "sandbox",
          },
        },
      );
    });
  });

  describe("Status Check", () => {
    it("should handle successful status check through requestPayment response", async () => {
      const mockResponse = {
        data: {
          referenceId: "test-reference-id",
          status: "SUCCESSFUL",
        },
      };

      mockAcceptedPayment(mockResponse);

      const result = await provider.requestPayment("+256123456789", "1000");

      expect(result.success).toBe(true);
      expect(result.data.status).toBe("SUCCESSFUL");
    });

    it("should handle pending status", async () => {
      const mockResponse = {
        data: {
          referenceId: "test-reference-id",
          status: "PENDING",
        },
      };

      mockAcceptedPayment(mockResponse);

      const result = await provider.requestPayment("+256123456789", "1000");

      expect(result.success).toBe(true);
      expect(result.data.status).toBe("PENDING");
    });

    it("should handle failed status", async () => {
      const mockResponse = {
        data: {
          referenceId: "test-reference-id",
          status: "FAILED",
        },
      };

      mockAcceptedPayment(mockResponse);

      const result = await provider.requestPayment("+256123456789", "1000");

      expect(result.success).toBe(true);
      expect(result.data.status).toBe("FAILED");
    });
  });

  describe("Edge Cases", () => {
    it("should handle extremely large amounts", async () => {
      const largeAmount = "999999999999";
      const mockResponse = { data: { referenceId: "test-ref" } };
      mockAcceptedPayment(mockResponse);

      const result = await provider.requestPayment(
        "+256123456789",
        largeAmount,
      );

      expect(result.success).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          amount: largeAmount,
        }),
        expect.any(Object),
      );
    });

    it("should handle international phone numbers", async () => {
      const internationalNumbers = [
        "+256123456789", // Uganda
        "+233123456789", // Ghana
        "+234123456789", // Nigeria
        "+254123456789", // Kenya
      ];

      const mockResponse = { data: { referenceId: "test-ref" } };
      mockAcceptedPayment(mockResponse);

      for (const phone of internationalNumbers) {
        const result = await provider.requestPayment(phone, "1000");
        expect(result.success).toBe(true);
      }
    });

    it("should handle special characters in amount", async () => {
      const specialAmount = "1000.50";
      const mockResponse = { data: { referenceId: "test-ref" } };
      mockAcceptedPayment(mockResponse);

      const result = await provider.requestPayment(
        "+256123456789",
        specialAmount,
      );

      expect(result.success).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          amount: specialAmount,
        }),
        expect.any(Object),
      );
    });
  });

  describe("Error Handling", () => {
    it("should handle malformed API response", async () => {
      const malformedResponse = {
        data: null, // Malformed response
      };

      mockAcceptedPayment(malformedResponse);

      const result = await provider.requestPayment("+256123456789", "1000");

      expect(result).toMatchObject({
        success: true,
        data: null,
      });
    });

    it("should handle empty API response", async () => {
      const emptyResponse = {};

      mockAcceptedPayment(emptyResponse);

      const result = await provider.requestPayment("+256123456789", "1000");

      expect(result).toMatchObject({
        success: true,
        data: undefined,
      });
    });

    it("should handle axios request cancellation", async () => {
      const cancelError = new Error("Request canceled");
      cancelError.name = "Cancel";

      mockedAxios.post.mockRejectedValue(cancelError);

      const result = await provider.requestPayment("+256123456789", "1000");

      expect(result).toMatchObject({
        success: false,
        error: cancelError,
      });
    });
  });
});
