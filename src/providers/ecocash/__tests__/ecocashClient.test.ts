import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import crypto from "crypto";
import {
  EcoCashClient,
  buildSigningPayload,
  signPayload,
  formatEcoCashReceipt,
} from "../ecocashClient";
import {
  validateEcoCashPayment,
  validateEcoCashDisbursement,
  normalizeEcoCashCurrency,
  ecocashCurrencySchema,
} from "../../../validators/ecocashValidator";

jest.mock("axios");
const axiosMock = axios as jest.Mocked<typeof axios>;

const scheduleEcoCashStatusPollMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../queue/ecocashStatusPollingQueue", () => ({
  scheduleEcoCashStatusPoll: (...args: unknown[]) =>
    scheduleEcoCashStatusPollMock(...args),
}));

function generateRsaKeyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

const clientConfig = {
  privateKey: "",
  merchantCode: "MERCH-ZW-001",
  merchantPin: "5678",
  baseUrl: "https://ecocash.example.test/merchant",
  depositPath: "/v1/payments",
  disbursePath: "/v1/disburse",
  statusPath: "/v1/status",
  timeoutMs: 5000,
};

describe("EcoCashValidator (#2558)", () => {
  it("accepts USD and ZIG (case-insensitive and ZiG alias)", () => {
    expect(normalizeEcoCashCurrency("USD")).toBe("USD");
    expect(normalizeEcoCashCurrency("usd")).toBe("USD");
    expect(normalizeEcoCashCurrency("ZIG")).toBe("ZIG");
    expect(normalizeEcoCashCurrency("zig")).toBe("ZIG");
    expect(normalizeEcoCashCurrency("ZiG")).toBe("ZIG");
  });

  it("rejects unsupported currencies", () => {
    expect(() => normalizeEcoCashCurrency("EUR")).toThrow("Unsupported currency");
    expect(() => normalizeEcoCashCurrency("GBP")).toThrow("Unsupported currency");
    expect(() => normalizeEcoCashCurrency("KES")).toThrow("Unsupported currency");
  });

  it("validates valid payment and disbursement input schemas", () => {
    const validDeposit = validateEcoCashPayment({
      phoneNumber: "+263771234567",
      amount: "50.00",
      currency: "USD",
    });
    expect(validDeposit.currency).toBe("USD");
    expect(validDeposit.amount).toBe(50);

    const validDisburse = validateEcoCashDisbursement({
      phoneNumber: "263771234567",
      amount: 1500,
      currency: "ZIG",
      exchangeRate: 13.5,
    });
    expect(validDisburse.currency).toBe("ZIG");
    expect(validDisburse.exchangeRate).toBe(13.5);
  });

  it("rejects invalid subscriber phone numbers", () => {
    expect(() =>
      validateEcoCashPayment({
        phoneNumber: "+2348012345678",
        amount: "50.00",
        currency: "USD",
      }),
    ).toThrow();
  });
});

describe("EcoCashClient Multi-currency Payment & Disbursement (#2558)", () => {
  let privateKey: string;
  let client: EcoCashClient;

  beforeEach(() => {
    jest.clearAllMocks();
    privateKey = generateRsaKeyPair().privateKey;
    client = new EcoCashClient({ ...clientConfig, privateKey });
  });

  describe("USD Payment Initiation (Collections / Deposit)", () => {
    it("submits USD payment to currency-specific endpoint with formatted body and receipt", async () => {
      axiosMock.post.mockResolvedValueOnce({
        data: {
          transactionId: "eco-tx-usd-dep-01",
          resultCode: "0",
          resultDesc: "Payment prompt dispatched to subscriber",
        },
      });

      const result = await client.requestPayment(
        "+263771234567",
        "25.50",
        "USD",
        { requestId: "req-usd-01" },
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.transactionId).toBe("eco-tx-usd-dep-01");
      expect(result.data?.settledCurrency).toBe("USD");
      expect(result.data?.exchangeRate).toBe(1.0);
      expect(result.data?.receipt).toContain("Settled Currency: USD");
      expect(result.data?.receipt).toContain("Exchange Rate: 1");

      expect(axiosMock.post).toHaveBeenCalledTimes(1);
      const [url, body] = axiosMock.post.mock.calls[0];
      expect(url).toBe("https://ecocash.example.test/merchant/v1/payments/usd");
      expect(body).toMatchObject({
        merchantCode: "MERCH-ZW-001",
        merchantPin: "5678",
        reference: "req-usd-01",
        msisdn: "263771234567",
        amount: 25.5,
        currency: "USD",
        settledCurrency: "USD",
        exchangeRate: 1.0,
      });
      expect(typeof body.signature).toBe("string");
    });
  });

  describe("ZiG Payment Initiation (Collections / Deposit)", () => {
    it("submits ZiG payment to currency-specific endpoint with accurate FX rate and receipt", async () => {
      axiosMock.post.mockResolvedValueOnce({
        data: {
          transactionId: "eco-tx-zig-dep-02",
          resultCode: "0",
          resultDesc: "Payment prompt dispatched to subscriber",
        },
      });

      const result = await client.requestPayment(
        "+263771234567",
        "350.00",
        "ZIG",
        {
          requestId: "req-zig-02",
          exchangeRate: 13.85,
        },
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.transactionId).toBe("eco-tx-zig-dep-02");
      expect(result.data?.settledCurrency).toBe("ZIG");
      expect(result.data?.exchangeRate).toBe(13.85);
      expect(result.data?.receipt).toContain("Settled Currency: ZIG");
      expect(result.data?.receipt).toContain("Exchange Rate: 13.85");

      expect(axiosMock.post).toHaveBeenCalledTimes(1);
      const [url, body] = axiosMock.post.mock.calls[0];
      expect(url).toBe("https://ecocash.example.test/merchant/v1/payments/zig");
      expect(body).toMatchObject({
        merchantCode: "MERCH-ZW-001",
        reference: "req-zig-02",
        amount: 350,
        currency: "ZIG",
        settledCurrency: "ZIG",
        exchangeRate: 13.85,
      });
    });

    it("accepts ZiG casing alias and normalizes to ZIG", async () => {
      axiosMock.post.mockResolvedValueOnce({
        data: {
          transactionId: "eco-tx-zig-alias",
          resultCode: "0",
        },
      });

      const result = await client.requestPayment(
        "+263771234567",
        "100",
        "ZiG",
      );

      expect(result.success).toBe(true);
      expect(result.data?.settledCurrency).toBe("ZIG");
      const [url] = axiosMock.post.mock.calls[0];
      expect(url).toBe("https://ecocash.example.test/merchant/v1/payments/zig");
    });
  });

  describe("Unsupported Currency Rejection", () => {
    it("rejects unsupported currency without making network call", async () => {
      const result = await client.requestPayment(
        "+263771234567",
        "100.00",
        "EUR",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unsupported currency");
      expect(result.error).toContain("USD and ZIG");
      expect(axiosMock.post).not.toHaveBeenCalled();
    });

    it("rejects unsupported currency for disbursement without making network call", async () => {
      const result = await client.disburse(
        "+263771234567",
        "100.00",
        "GBP",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unsupported currency");
      expect(axiosMock.post).not.toHaveBeenCalled();
    });
  });

  describe("Disbursement (Payouts in USD and ZiG)", () => {
    it("submits USD disbursement to currency-specific endpoint and schedules status poll", async () => {
      axiosMock.post.mockResolvedValueOnce({
        data: {
          transactionId: "eco-disb-usd-01",
          resultCode: "0",
          resultDesc: "Disbursement accepted",
        },
      });

      const result = await client.disburse(
        "+263771234567",
        "75.00",
        "USD",
        "ref-disb-usd-01",
      );

      expect(result.success).toBe(true);
      expect(result.data?.settledCurrency).toBe("USD");
      expect(result.data?.exchangeRate).toBe(1.0);
      expect(scheduleEcoCashStatusPollMock).toHaveBeenCalledWith(
        "eco-disb-usd-01",
      );

      const [url, body] = axiosMock.post.mock.calls[0];
      expect(url).toBe("https://ecocash.example.test/merchant/v1/disburse/usd");
      expect(body.wallet).toBe("USD");
      expect(body.settledCurrency).toBe("USD");
    });

    it("submits ZiG disbursement to currency-specific endpoint with exchange rate and receipt", async () => {
      axiosMock.post.mockResolvedValueOnce({
        data: {
          transactionId: "eco-disb-zig-02",
          resultCode: "0",
          resultDesc: "Disbursement accepted",
        },
      });

      const result = await client.disburse(
        "+263771234567",
        "1000.00",
        "ZIG",
        "ref-disb-zig-02",
        { exchangeRate: 14.2 },
      );

      expect(result.success).toBe(true);
      expect(result.data?.settledCurrency).toBe("ZIG");
      expect(result.data?.exchangeRate).toBe(14.2);
      expect(result.data?.receipt).toContain("Settled Currency: ZIG");
      expect(result.data?.receipt).toContain("Exchange Rate: 14.2");

      const [url, body] = axiosMock.post.mock.calls[0];
      expect(url).toBe("https://ecocash.example.test/merchant/v1/disburse/zig");
      expect(body.wallet).toBe("ZIG");
      expect(body.exchangeRate).toBe(14.2);
    });
  });

  describe("Receipt Formatting", () => {
    it("records settled currency and exchange rate accurately in receipt string", () => {
      const receipt = formatEcoCashReceipt({
        transactionId: "eco-txn-receipt-001",
        reference: "ref-rcpt-01",
        phoneNumber: "263771234567",
        amount: 250,
        currency: "ZIG",
        settledCurrency: "ZIG",
        exchangeRate: 13.5,
        status: "SUCCESS",
        timestamp: "2026-11-24T12:00:00.000Z",
      });

      expect(receipt).toContain("ECOCASH TRANSACTION RECEIPT");
      expect(receipt).toContain("Amount: 250 ZIG");
      expect(receipt).toContain("Settled Currency: ZIG");
      expect(receipt).toContain("Exchange Rate: 13.5");
      expect(receipt).toContain("Status: SUCCESS");
    });
  });
});
