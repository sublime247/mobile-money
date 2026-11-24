import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { MoovCoteDivoireProvider } from "../moovCoteDivoire";

jest.mock("axios");

const axiosMock = axios as jest.Mocked<typeof axios>;

function createMockAxiosError(
  status: number,
  data?: Record<string, unknown>,
): AxiosError {
  const config = {} as InternalAxiosRequestConfig;
  const response = {
    status,
    statusText: "",
    headers: {},
    config,
    data,
  };
  return new AxiosError("Request failed", String(status), config, {}, response as never);
}

const providerConfig = {
  apiKey: "test-client-id",
  apiSecret: "test-client-secret",
  baseUrl: "https://moov.example.test",
  authPath: "/auth/token",
  depositPushPath: "/deposits/push",
  timeoutMs: 5_000,
};

describe("MoovCoteDivoireProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getAccessToken", () => {
    it("acquires and caches an access token", async () => {
      axiosMock.post.mockResolvedValueOnce({
        data: { access_token: "moov-token", expires_in: 3600 },
      });
      const provider = new MoovCoteDivoireProvider(providerConfig);

      await expect(provider.getAccessToken()).resolves.toBe("moov-token");
      await expect(provider.getAccessToken()).resolves.toBe("moov-token");

      expect(axiosMock.post).toHaveBeenCalledTimes(1);
      expect(axiosMock.post).toHaveBeenCalledWith(
        "https://moov.example.test/auth/token",
        { grant_type: "client_credentials" },
        {
          headers: {
            Authorization: `Basic ${Buffer.from(
              "test-client-id:test-client-secret",
            ).toString("base64")}`,
            "Content-Type": "application/json",
          },
          timeout: 5_000,
        },
      );
    });

    it("rejects an incomplete token response", async () => {
      axiosMock.post.mockResolvedValueOnce({
        data: { expires_in: 3600 },
      });
      const provider = new MoovCoteDivoireProvider(providerConfig);

      await expect(provider.getAccessToken()).rejects.toThrow(
        "token response is missing required fields",
      );
    });

    it("rejects incomplete provider configuration", async () => {
      const provider = new MoovCoteDivoireProvider({
        ...providerConfig,
        apiSecret: "",
      });

      await expect(provider.getAccessToken()).rejects.toThrow(
        "API configuration is incomplete",
      );
      expect(axiosMock.post).not.toHaveBeenCalled();
    });
  });

  describe("triggerDepositPush", () => {
    it("triggers an authenticated XOF deposit push", async () => {
      axiosMock.post
        .mockResolvedValueOnce({
          data: { access_token: "moov-token", expires_in: 3600 },
        })
        .mockResolvedValueOnce({
          data: { transactionId: "moov-transaction-1", status: "PENDING" },
        });
      const provider = new MoovCoteDivoireProvider(providerConfig);

      const result = await provider.triggerDepositPush(
        "+225 07 01 02 03 04",
        "5000",
        "deposit-1",
      );

      expect(result).toEqual({
        success: true,
        referenceId: "deposit-1",
        data: {
          transactionId: "moov-transaction-1",
          status: "PENDING",
        },
      });
      expect(axiosMock.post).toHaveBeenNthCalledWith(
        2,
        "https://moov.example.test/deposits/push",
        {
          amount: 5000,
          currency: "XOF",
          phoneNumber: "2250701020304",
          referenceId: "deposit-1",
        },
        {
          headers: {
            Authorization: "Bearer moov-token",
            "Content-Type": "application/json",
          },
          timeout: 5_000,
        },
      );
    });

    it("rejects phone numbers outside Côte d'Ivoire", async () => {
      const provider = new MoovCoteDivoireProvider(providerConfig);

      const result = await provider.triggerDepositPush(
        "+2348012345678",
        5000,
        "deposit-2",
      );

      expect(result).toEqual({
        success: false,
        referenceId: "deposit-2",
        error: "Invalid Côte d'Ivoire phone number",
      });
      expect(axiosMock.post).not.toHaveBeenCalled();
    });

    it("rejects non-positive deposit amounts", async () => {
      const provider = new MoovCoteDivoireProvider(providerConfig);

      const result = await provider.triggerDepositPush(
        "0701020304",
        0,
        "deposit-3",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Deposit amount must be greater than zero");
      expect(axiosMock.post).not.toHaveBeenCalled();
    });

    it("returns a safe error when the provider request fails", async () => {
      axiosMock.post
        .mockResolvedValueOnce({
          data: { access_token: "moov-token", expires_in: 3600 },
        })
        .mockRejectedValueOnce(new Error("upstream failure"));
      const provider = new MoovCoteDivoireProvider(providerConfig);

      const result = await provider.requestPayment(
        "0701020304",
        "5000",
        "deposit-4",
      );

      expect(result).toEqual({
        success: false,
        referenceId: "deposit-4",
        error: "Moov Côte d'Ivoire deposit push failed",
      });
    });

    it("maps an INSUFFICIENT_BALANCE response code to a specific error message", async () => {
      axiosMock.post
        .mockResolvedValueOnce({
          data: { access_token: "moov-token", expires_in: 3600 },
        })
        .mockRejectedValueOnce(
          createMockAxiosError(400, { code: "INSUFFICIENT_BALANCE" }),
        );
      const provider = new MoovCoteDivoireProvider(providerConfig);

      const result = await provider.requestPayment(
        "0701020304",
        "5000",
        "deposit-5",
      );

      expect(result).toEqual({
        success: false,
        referenceId: "deposit-5",
        error: "Insufficient balance in the Moov Money account",
      });
    });

    it("maps a bare HTTP 402 (no body code) to insufficient balance", async () => {
      axiosMock.post
        .mockResolvedValueOnce({
          data: { access_token: "moov-token", expires_in: 3600 },
        })
        .mockRejectedValueOnce(createMockAxiosError(402));
      const provider = new MoovCoteDivoireProvider(providerConfig);

      const result = await provider.requestPayment(
        "0701020304",
        "5000",
        "deposit-6",
      );

      expect(result).toEqual({
        success: false,
        referenceId: "deposit-6",
        error: "Insufficient balance in the Moov Money account",
      });
    });

    it("falls back to the generic message for an unrecognised error code", async () => {
      axiosMock.post
        .mockResolvedValueOnce({
          data: { access_token: "moov-token", expires_in: 3600 },
        })
        .mockRejectedValueOnce(
          createMockAxiosError(400, { code: "SOME_UNMAPPED_CODE" }),
        );
      const provider = new MoovCoteDivoireProvider(providerConfig);

      const result = await provider.requestPayment(
        "0701020304",
        "5000",
        "deposit-7",
      );

      expect(result).toEqual({
        success: false,
        referenceId: "deposit-7",
        error: "Moov Côte d'Ivoire deposit push failed",
      });
    });
  });
});
