import axios from "axios";
import {
  MpesaProvider,
  MPESA_CALLBACK_ACK,
  MpesaStkCallbackBody,
  MpesaB2CResultBody,
  MpesaB2CTimeoutBody,
} from "../mpesaService";

jest.mock("axios");

const axiosMock = axios as jest.Mocked<typeof axios>;

describe("MpesaProvider", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.MPESA_CONSUMER_KEY = "test-consumer-key";
    process.env.MPESA_CONSUMER_SECRET = "test-consumer-secret";
    process.env.MPESA_BASE_URL = "https://sandbox.safaricom.co.ke";
    process.env.MPESA_SHORTCODE = "174379";
    process.env.MPESA_PASSKEY = "test-passkey";
    process.env.MPESA_CALLBACK_URL = "https://example.com/mpesa/callback";
    process.env.MPESA_INITIATOR_NAME = "testapi";
    process.env.MPESA_SECURITY_CREDENTIAL = "encrypted-credential";
    process.env.MPESA_RESULT_URL = "https://example.com/mpesa/result";
    process.env.MPESA_QUEUE_TIMEOUT_URL = "https://example.com/mpesa/timeout";
  });

  describe("getAccessToken (OAuth2 client credentials)", () => {
    it("fetches and caches an access token using Basic auth", async () => {
      axiosMock.get.mockResolvedValueOnce({
        data: { access_token: "abc123", expires_in: "3599" },
      });

      const provider = new MpesaProvider();
      const token = await provider.getAccessToken();

      expect(token).toBe("abc123");
      expect(axiosMock.get).toHaveBeenCalledWith(
        expect.stringContaining("/oauth/v1/generate?grant_type=client_credentials"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
          }),
        }),
      );

      // Second call should use the cached token, not hit the network again
      const token2 = await provider.getAccessToken();
      expect(token2).toBe("abc123");
      expect(axiosMock.get).toHaveBeenCalledTimes(1);
    });

    it("throws when the token response is missing access_token", async () => {
      axiosMock.get.mockResolvedValueOnce({ data: {} });

      const provider = new MpesaProvider();
      await expect(provider.getAccessToken()).rejects.toThrow(
        "M-Pesa token response did not include access_token",
      );
    });
  });

  describe("initiateStkPush (C2B)", () => {
    it("configures and sends a Lipa Na M-Pesa STK push request", async () => {
      axiosMock.get.mockResolvedValueOnce({
        data: { access_token: "abc123", expires_in: "3599" },
      });
      axiosMock.post.mockResolvedValueOnce({
        data: {
          MerchantRequestID: "merchant-1",
          CheckoutRequestID: "checkout-1",
          ResponseCode: "0",
          ResponseDescription: "Success. Request accepted for processing",
        },
      });

      const provider = new MpesaProvider();
      const result = await provider.initiateStkPush(
        "0712345678",
        500,
        "ORDER-1",
      );

      expect(result.success).toBe(true);
      expect(result.merchantRequestId).toBe("merchant-1");
      expect(result.checkoutRequestId).toBe("checkout-1");

      const [url, body] = axiosMock.post.mock.calls[0];
      expect(url).toContain("/mpesa/stkpush/v1/processrequest");
      expect(body).toMatchObject({
        BusinessShortCode: "174379",
        Amount: 500,
        PartyA: "254712345678",
        PhoneNumber: "254712345678",
        AccountReference: "ORDER-1",
      });
    });

    it("returns a failure result when the request errors", async () => {
      axiosMock.get.mockResolvedValueOnce({
        data: { access_token: "abc123", expires_in: "3599" },
      });
      axiosMock.post.mockRejectedValueOnce(new Error("network error"));

      const provider = new MpesaProvider();
      const result = await provider.initiateStkPush(
        "0712345678",
        500,
        "ORDER-1",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    });

    it("normalizes phone numbers already in 2547XXXXXXXX format", async () => {
      axiosMock.get.mockResolvedValueOnce({
        data: { access_token: "abc123", expires_in: "3599" },
      });
      axiosMock.post.mockResolvedValueOnce({ data: {} });

      const provider = new MpesaProvider();
      await provider.initiateStkPush("254712345678", 100, "REF");

      const [, body] = axiosMock.post.mock.calls[0];
      expect((body as any).PartyA).toBe("254712345678");
    });
  });

  describe("sendB2CPayment (B2C payout)", () => {
    it("sends a BusinessPayment disbursement request", async () => {
      axiosMock.get.mockResolvedValueOnce({
        data: { access_token: "abc123", expires_in: "3599" },
      });
      axiosMock.post.mockResolvedValueOnce({
        data: {
          ConversationID: "conv-1",
          OriginatorConversationID: "origin-1",
          ResponseCode: "0",
          ResponseDescription: "Accept the service request successfully.",
        },
      });

      const provider = new MpesaProvider();
      const result = await provider.sendB2CPayment("0712345678", 2000);

      expect(result.success).toBe(true);
      expect(result.conversationId).toBe("conv-1");

      const [url, body] = axiosMock.post.mock.calls[0];
      expect(url).toContain("/mpesa/b2c/v1/paymentrequest");
      expect(body).toMatchObject({
        CommandID: "BusinessPayment",
        Amount: 2000,
        PartyB: "254712345678",
      });
    });

    it("returns a failure result when the disbursement request errors", async () => {
      axiosMock.get.mockResolvedValueOnce({
        data: { access_token: "abc123", expires_in: "3599" },
      });
      axiosMock.post.mockRejectedValueOnce(new Error("timeout"));

      const provider = new MpesaProvider();
      const result = await provider.sendB2CPayment("0712345678", 2000);

      expect(result.success).toBe(false);
    });
  });

  describe("getTransactionStatus", () => {
    it("maps ResultCode 0 to completed", async () => {
      axiosMock.get.mockResolvedValueOnce({
        data: { access_token: "abc123", expires_in: "3599" },
      });
      axiosMock.post.mockResolvedValueOnce({ data: { ResultCode: 0 } });

      const provider = new MpesaProvider();
      const result = await provider.getTransactionStatus("checkout-1");
      expect(result.status).toBe("completed");
    });

    it("maps a non-zero ResultCode to failed", async () => {
      axiosMock.get.mockResolvedValueOnce({
        data: { access_token: "abc123", expires_in: "3599" },
      });
      axiosMock.post.mockResolvedValueOnce({ data: { ResultCode: 1032 } });

      const provider = new MpesaProvider();
      const result = await provider.getTransactionStatus("checkout-1");
      expect(result.status).toBe("failed");
    });

    it("returns unknown when the status query throws", async () => {
      axiosMock.get.mockResolvedValueOnce({
        data: { access_token: "abc123", expires_in: "3599" },
      });
      axiosMock.post.mockRejectedValueOnce(new Error("down"));

      const provider = new MpesaProvider();
      const result = await provider.getTransactionStatus("checkout-1");
      expect(result.status).toBe("unknown");
    });
  });

  describe("processStkCallback", () => {
    it("parses a successful callback and extracts CallbackMetadata fields", () => {
      const body: MpesaStkCallbackBody = {
        Body: {
          stkCallback: {
            MerchantRequestID: "merchant-1",
            CheckoutRequestID: "checkout-1",
            ResultCode: 0,
            ResultDesc: "The service request is processed successfully.",
            CallbackMetadata: {
              Item: [
                { Name: "Amount", Value: 500 },
                { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" },
                { Name: "TransactionDate", Value: 20260727121500 },
                { Name: "PhoneNumber", Value: 254712345678 },
              ],
            },
          },
        },
      };

      const result = MpesaProvider.processStkCallback(body);

      expect(result.success).toBe(true);
      expect(result.amount).toBe(500);
      expect(result.mpesaReceiptNumber).toBe("NLJ7RT61SV");
      expect(result.phoneNumber).toBe("254712345678");
    });

    it("parses a cancelled/failed callback with no CallbackMetadata", () => {
      const body: MpesaStkCallbackBody = {
        Body: {
          stkCallback: {
            MerchantRequestID: "merchant-2",
            CheckoutRequestID: "checkout-2",
            ResultCode: 1032,
            ResultDesc: "Request cancelled by user.",
          },
        },
      };

      const result = MpesaProvider.processStkCallback(body);

      expect(result.success).toBe(false);
      expect(result.amount).toBeUndefined();
      expect(result.resultDesc).toBe("Request cancelled by user.");
    });

    it("exposes the acknowledgement Safaricom expects in the HTTP response", () => {
      expect(MPESA_CALLBACK_ACK).toEqual({
        ResultCode: 0,
        ResultDesc: "Success",
      });
    });
  });

  describe("processB2CResult", () => {
    it("parses a successful B2C result and extracts ResultParameters fields", () => {
      const body: MpesaB2CResultBody = {
        Result: {
          ResultType: 0,
          ResultCode: 0,
          ResultDesc: "The service request is processed successfully.",
          OriginatorConversationID: "orig-conv-1",
          ConversationID: "AG_20260928_1234567890",
          TransactionID: "NLJ7RT61SV",
          ResultParameters: {
            ResultParameter: [
              { Key: "TransactionAmount", Value: 1000 },
              { Key: "TransactionReceipt", Value: "NLJ7RT61SV" },
              {
                Key: "TransactionCompletedDateTime",
                Value: "28.09.2026 10:00:00",
              },
              { Key: "ReceiverPartyPublicName", Value: "254712345678 - John Doe" },
              { Key: "B2CUtilityAccountAvailableFunds", Value: 500000 },
              { Key: "B2CWorkingAccountAvailableFunds", Value: 250000 },
            ],
          },
        },
      };

      const outcome = MpesaProvider.processB2CResult(body);

      expect(outcome.status).toBe("completed");
      expect(outcome.conversationId).toBe("AG_20260928_1234567890");
      expect(outcome.originatorConversationId).toBe("orig-conv-1");
      expect(outcome.transactionId).toBe("NLJ7RT61SV");
      expect(outcome.transactionAmount).toBe(1000);
      expect(outcome.transactionReceipt).toBe("NLJ7RT61SV");
      expect(outcome.receiverPartyPublicName).toBe(
        "254712345678 - John Doe",
      );
      expect(outcome.b2cUtilityAccountAvailableFunds).toBe(500000);
      expect(outcome.b2cWorkingAccountAvailableFunds).toBe(250000);
    });

    it("parses a failed B2C result without ResultParameters", () => {
      const body: MpesaB2CResultBody = {
        Result: {
          ResultType: 0,
          ResultCode: 2001,
          ResultDesc: "The initiator information is invalid.",
          OriginatorConversationID: "orig-conv-2",
          ConversationID: "AG_20260928_0987654321",
        },
      };

      const outcome = MpesaProvider.processB2CResult(body);

      expect(outcome.status).toBe("failed");
      expect(outcome.resultCode).toBe(2001);
      expect(outcome.transactionAmount).toBeUndefined();
      expect(outcome.transactionReceipt).toBeUndefined();
    });

    it("treats any non-zero result code as failed, not just documented codes", () => {
      const body: MpesaB2CResultBody = {
        Result: {
          ResultType: 0,
          ResultCode: 9999,
          ResultDesc: "Unexpected error.",
          OriginatorConversationID: "orig-conv-3",
          ConversationID: "AG_conv-3",
        },
      };

      expect(MpesaProvider.processB2CResult(body).status).toBe("failed");
    });
  });

  describe("processB2CTimeout", () => {
    it("normalizes a queue timeout callback to a failed outcome", () => {
      const body: MpesaB2CTimeoutBody = {
        Result: {
          ResultType: 1,
          ResultCode: 1,
          ResultDesc: "The service request timed out.",
          OriginatorConversationID: "orig-conv-timeout",
          ConversationID: "AG_conv-timeout",
        },
      };

      const outcome = MpesaProvider.processB2CTimeout(body);

      expect(outcome.status).toBe("failed");
      expect(outcome.originatorConversationId).toBe("orig-conv-timeout");
      expect(outcome.conversationId).toBe("AG_conv-timeout");
      expect(outcome.resultDesc).toBe("The service request timed out.");
    });

    it("falls back to a default message when ResultDesc is empty", () => {
      const body: MpesaB2CTimeoutBody = {
        Result: {
          ResultType: 1,
          ResultCode: 1,
          ResultDesc: "",
          OriginatorConversationID: "orig-conv-empty",
          ConversationID: "AG_conv-empty",
        },
      };

      expect(MpesaProvider.processB2CTimeout(body).resultDesc).toBe(
        "B2C request timed out in queue",
      );
    });
  });
});
