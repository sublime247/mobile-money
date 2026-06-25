import axios from "axios";
import crypto from "crypto";
import { MoovProvider } from "../moov";

jest.mock("axios");

const axiosMock = axios as any;

describe("MoovProvider", () => {
  let privateKey: string;
  let publicKey: string;

  beforeAll(() => {
    // Generate RSA key pair dynamically for testing
    const keys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.MOOV_PRIVATE_KEY = privateKey;
    process.env.MOOV_PUBLIC_KEY = publicKey;
    process.env.MOOV_BASE_URL = "https://api.moov.com/soap-test";
  });

  function mockSoapResponse(bodyContent: string): string {
    const cleanBody = bodyContent.trim();
    const sign = crypto.createSign("SHA256");
    sign.update(cleanBody);
    const signature = sign.sign(privateKey, "base64");

    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <Signature xmlns="http://www.moov.com/security">${signature}</Signature>
  </soap:Header>
  <soap:Body>
    ${cleanBody}
  </soap:Body>
</soap:Envelope>`;
  }

  describe("Initialization & Signing Utility", () => {
    it("should throw error if private key is missing when signing", () => {
      delete process.env.MOOV_PRIVATE_KEY;
      const provider = new MoovProvider();
      expect(() => provider.signPayload("<xml></xml>")).toThrow("Moov Provider: Private key (MOOV_PRIVATE_KEY) is missing");
    });

    it("should throw error if public key is missing when verifying", () => {
      delete process.env.MOOV_PUBLIC_KEY;
      const provider = new MoovProvider();
      expect(() => provider.verifyResponse("<xml></xml>", "sig")).toThrow("Moov Provider: Public key (MOOV_PUBLIC_KEY) is missing");
    });

    it("should sign and verify successfully", () => {
      const provider = new MoovProvider();
      const payload = "<data>test</data>";
      const sig = provider.signPayload(payload);
      expect(sig).toBeTruthy();
      expect(provider.verifyResponse(payload, sig)).toBe(true);
    });
  });

  describe("requestPayment", () => {
    it("should process deposit successfully for supported countries (Benin, Togo, Cote d'Ivoire)", async () => {
      const provider = new MoovProvider();
      const mockResponseXml = mockSoapResponse(`
        <RequestPaymentResponse>
          <Status>SUCCESS</Status>
          <TransactionId>moov-txn-pay-123</TransactionId>
        </RequestPaymentResponse>
      `);

      axiosMock.post.mockResolvedValue({ data: mockResponseXml });

      const res = await provider.requestPayment("+22990000001", "5000", "test-req-123");

      expect(res.success).toBe(true);
      expect(res.data).toEqual({
        transactionId: "moov-txn-pay-123",
        status: "SUCCESS",
      });
      expect(axiosMock.post).toHaveBeenCalled();
    });

    it("should fail when phone number country code is unsupported", async () => {
      const provider = new MoovProvider();
      const res = await provider.requestPayment("+2348000000001", "5000", "test-req-123");

      expect(res.success).toBe(false);
      expect(res.error).toContain("Moov Money only supports Benin");
      expect(axiosMock.post).not.toHaveBeenCalled();
    });

    it("should fail when SOAP response signature verification fails", async () => {
      const provider = new MoovProvider();
      const mockResponseXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <Signature xmlns="http://www.moov.com/security">invalid-signature-here</Signature>
  </soap:Header>
  <soap:Body>
    <RequestPaymentResponse>
      <Status>SUCCESS</Status>
      <TransactionId>moov-txn-pay-123</TransactionId>
    </RequestPaymentResponse>
  </soap:Body>
</soap:Envelope>`;

      axiosMock.post.mockResolvedValue({ data: mockResponseXml });

      const res = await provider.requestPayment("+22890000001", "5000", "test-req-123");

      expect(res.success).toBe(false);
      expect(res.error).toContain("Response signature verification failed");
    });

    it("should fail when provider returns failed status", async () => {
      const provider = new MoovProvider();
      const mockResponseXml = mockSoapResponse(`
        <RequestPaymentResponse>
          <Status>FAILED</Status>
          <ErrorDetail>Insufficient balance</ErrorDetail>
        </RequestPaymentResponse>
      `);

      axiosMock.post.mockResolvedValue({ data: mockResponseXml });

      const res = await provider.requestPayment("+22590000001", "5000", "test-req-123");

      expect(res.success).toBe(false);
      expect(res.error).toBe("Insufficient balance");
    });
  });

  describe("sendPayout", () => {
    it("should process payout successfully for supported countries", async () => {
      const provider = new MoovProvider();
      const mockResponseXml = mockSoapResponse(`
        <SendPayoutResponse>
          <Status>SUCCESS</Status>
          <TransactionId>moov-txn-out-123</TransactionId>
        </SendPayoutResponse>
      `);

      axiosMock.post.mockResolvedValue({ data: mockResponseXml });

      const res = await provider.sendPayout("+22990000001", "1000", "test-req-456");

      expect(res.success).toBe(true);
      expect(res.data).toEqual({
        transactionId: "moov-txn-out-123",
        status: "SUCCESS",
      });
    });

    it("should fail when phone number country code is unsupported", async () => {
      const provider = new MoovProvider();
      const res = await provider.sendPayout("+14155552671", "1000", "test-req-456");

      expect(res.success).toBe(false);
      expect(res.error).toContain("Moov Money only supports Benin");
    });

    it("should fail when provider returns failed status for payout", async () => {
      const provider = new MoovProvider();
      const mockResponseXml = mockSoapResponse(`
        <SendPayoutResponse>
          <Status>FAILED</Status>
          <ErrorDetail>Limit exceeded</ErrorDetail>
        </SendPayoutResponse>
      `);

      axiosMock.post.mockResolvedValue({ data: mockResponseXml });

      const res = await provider.sendPayout("+22590000001", "1000000", "test-req-456");

      expect(res.success).toBe(false);
      expect(res.error).toBe("Limit exceeded");
    });
  });

  describe("getTransactionStatus", () => {
    it("should return completed when status is SUCCESS", async () => {
      const provider = new MoovProvider();
      const mockResponseXml = mockSoapResponse(`
        <GetTransactionStatusResponse>
          <Status>SUCCESS</Status>
        </GetTransactionStatusResponse>
      `);

      axiosMock.post.mockResolvedValue({ data: mockResponseXml });

      const res = await provider.getTransactionStatus("moov-ref-123");
      expect(res.status).toBe("completed");
    });

    it("should return completed when status is COMPLETED", async () => {
      const provider = new MoovProvider();
      const mockResponseXml = mockSoapResponse(`
        <GetTransactionStatusResponse>
          <Status>COMPLETED</Status>
        </GetTransactionStatusResponse>
      `);

      axiosMock.post.mockResolvedValue({ data: mockResponseXml });

      const res = await provider.getTransactionStatus("moov-ref-123");
      expect(res.status).toBe("completed");
    });

    it("should return failed when status is FAILED", async () => {
      const provider = new MoovProvider();
      const mockResponseXml = mockSoapResponse(`
        <GetTransactionStatusResponse>
          <Status>FAILED</Status>
        </GetTransactionStatusResponse>
      `);

      axiosMock.post.mockResolvedValue({ data: mockResponseXml });

      const res = await provider.getTransactionStatus("moov-ref-123");
      expect(res.status).toBe("failed");
    });

    it("should return pending when status is PENDING", async () => {
      const provider = new MoovProvider();
      const mockResponseXml = mockSoapResponse(`
        <GetTransactionStatusResponse>
          <Status>PENDING</Status>
        </GetTransactionStatusResponse>
      `);

      axiosMock.post.mockResolvedValue({ data: mockResponseXml });

      const res = await provider.getTransactionStatus("moov-ref-123");
      expect(res.status).toBe("pending");
    });

    it("should return unknown when status is unrecognized", async () => {
      const provider = new MoovProvider();
      const mockResponseXml = mockSoapResponse(`
        <GetTransactionStatusResponse>
          <Status>REJECTED</Status>
        </GetTransactionStatusResponse>
      `);

      axiosMock.post.mockResolvedValue({ data: mockResponseXml });

      const res = await provider.getTransactionStatus("moov-ref-123");
      expect(res.status).toBe("unknown");
    });

    it("should return unknown when request throws an error", async () => {
      const provider = new MoovProvider();
      axiosMock.post.mockRejectedValue(new Error("Connection timeout"));

      const res = await provider.getTransactionStatus("moov-ref-123");
      expect(res.status).toBe("unknown");
    });
  });
});
