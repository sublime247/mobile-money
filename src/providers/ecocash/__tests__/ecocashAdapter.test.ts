import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import crypto from "crypto";
import {
  EcoCashAdapter,
  buildSigningPayload,
  signPayload,
} from "../ecocashAdapter";

jest.mock("axios");
const axiosMock = axios as jest.Mocked<typeof axios>;

// #2365: disburse() schedules a status-poll fallback job via BullMQ after a
// successful submission. These adapter tests exercise the HTTP/signing
// logic in isolation, so the queue is mocked rather than hitting a real
// Redis connection (which would hang in CI without one).
const scheduleEcoCashStatusPollMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../queue/ecocashStatusPollingQueue", () => ({
  scheduleEcoCashStatusPoll: (...args: unknown[]) =>
    scheduleEcoCashStatusPollMock(...args),
}));

function createMockAxiosError(
  status: number,
  data?: Record<string, unknown>,
): AxiosError {
  const config = {} as InternalAxiosRequestConfig;
  const response = { status, statusText: "", headers: {}, config, data };
  return new AxiosError(
    "Request failed",
    String(status),
    config,
    {},
    response as never,
  );
}

function generateRsaKeyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

const adapterConfig = {
  privateKey: "",
  merchantCode: "MERCH123",
  merchantPin: "1234",
  baseUrl: "https://ecocash.example.test/merchant",
  disbursePath: "/v1/disburse",
  statusPath: "/v1/status",
  timeoutMs: 5_000,
};

describe("buildSigningPayload / signPayload", () => {
  it("produces a deterministic pipe-delimited canonical string", () => {
    const payload = buildSigningPayload({
      merchantCode: "MERCH123",
      reference: "ref-1",
      msisdn: "263771234567",
      amount: "100",
      wallet: "USD",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(payload).toBe(
      "MERCH123|ref-1|263771234567|100|USD|2026-01-01T00:00:00.000Z",
    );
  });

  it("signs a payload verifiably with the matching RSA public key", () => {
    const { privateKey, publicKey } = generateRsaKeyPair();
    const payload =
      "MERCH123|ref-1|263771234567|100|USD|2026-01-01T00:00:00.000Z";

    const signature = signPayload(payload, privateKey);

    const verify = crypto.createVerify("SHA256");
    verify.update(payload);
    expect(verify.verify(publicKey, signature, "base64")).toBe(true);
  });

  it("throws when no private key is configured", () => {
    expect(() => signPayload("payload", "")).toThrow("private key is missing");
  });
});

describe("EcoCashAdapter.disburse", () => {
  let privateKey: string;

  beforeEach(() => {
    jest.clearAllMocks();
    privateKey = generateRsaKeyPair().privateKey;
  });

  it("submits a disbursement with a valid RSA signature and USD wallet by default", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: {
        transactionId: "eco-txn-1",
        resultCode: "0",
        resultDesc: "Success",
      },
    });
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    const result = await adapter.disburse(
      "+263771234567",
      "150.00",
      "USD",
      "ref-1",
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      transactionId: "eco-txn-1",
      resultCode: "0",
      resultDesc: "Success",
    });

    expect(axiosMock.post).toHaveBeenCalledTimes(1);
    const [url, body, options] = axiosMock.post.mock.calls[0];
    expect(url).toBe("https://ecocash.example.test/merchant/v1/disburse");
    expect(body).toMatchObject({
      merchantCode: "MERCH123",
      merchantPin: "1234",
      reference: "ref-1",
      msisdn: "263771234567",
      amount: 150,
      wallet: "USD",
    });
    expect(typeof body.signature).toBe("string");
    expect(options).toMatchObject({ timeout: 5_000 });
  });

  it("schedules a status-poll fallback job after a successful disbursement (#2365)", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { transactionId: "eco-txn-poll-1", resultCode: "0" },
    });
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    await adapter.disburse("+263771234567", "150.00", "USD", "ref-poll-1");

    expect(scheduleEcoCashStatusPollMock).toHaveBeenCalledWith(
      "eco-txn-poll-1",
    );
  });

  it("does not fail the disbursement if scheduling the status poll throws", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { transactionId: "eco-txn-poll-2", resultCode: "0" },
    });
    scheduleEcoCashStatusPollMock.mockRejectedValueOnce(
      new Error("redis unavailable"),
    );
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    const result = await adapter.disburse(
      "+263771234567",
      "150.00",
      "USD",
      "ref-poll-2",
    );

    expect(result.success).toBe(true);
  });

  it("does not attempt to schedule a status poll when the disbursement request fails validation", async () => {
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    await adapter.disburse("+1234567890", "150.00", "USD", "ref-invalid");

    expect(axiosMock.post).not.toHaveBeenCalled();
    expect(scheduleEcoCashStatusPollMock).not.toHaveBeenCalled();
  });

  it("supports disbursing from the ZWL wallet", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { transactionId: "eco-txn-2", resultCode: "0" },
    });
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    await adapter.disburse("+263771234567", "500", "ZWL", "ref-2");

    const [, body] = axiosMock.post.mock.calls[0];
    expect(body.wallet).toBe("ZWL");
  });

  it("rejects a non-Zimbabwe phone number without calling the API", async () => {
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    const result = await adapter.disburse("+2348012345678", "100", "USD");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Zimbabwe (+263)");
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount without calling the API", async () => {
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    const result = await adapter.disburse("+263771234567", "0", "USD");

    expect(result.success).toBe(false);
    expect(result.error).toContain("positive number");
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("rejects when merchant credentials are not configured", async () => {
    const adapter = new EcoCashAdapter({
      ...adapterConfig,
      privateKey,
      merchantCode: "",
    });

    const result = await adapter.disburse("+263771234567", "100", "USD");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("maps an insufficient-balance resultCode to a friendly, non-retryable error", async () => {
    axiosMock.post.mockRejectedValueOnce(
      createMockAxiosError(402, { resultCode: "INS_1" }),
    );
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    const result = await adapter.disburse("+263771234567", "100", "USD");

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Insufficient balance in the EcoCash merchant account",
    );
    expect(result.providerErrorCode).toBe("INS_1");
    expect(result.retryable).toBe(false);
  });

  it("maps a service-unavailable resultCode to a retryable error", async () => {
    axiosMock.post.mockRejectedValueOnce(
      createMockAxiosError(503, { resultCode: "INS_10" }),
    );
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    const result = await adapter.disburse("+263771234567", "100", "USD");

    expect(result.retryable).toBe(true);
  });

  it("falls back to a generic message for an unrecognized resultCode", async () => {
    axiosMock.post.mockRejectedValueOnce(
      createMockAxiosError(400, { resultCode: "SOME_UNKNOWN_CODE" }),
    );
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    const result = await adapter.disburse("+263771234567", "100", "USD");

    expect(result.error).toBe("EcoCash disbursement request failed");
    expect(result.retryable).toBe(false);
  });
});

describe("EcoCashAdapter.sendPayout (MobileMoneyProvider interface)", () => {
  it("delegates to disburse() on the USD wallet", async () => {
    const { privateKey } = generateRsaKeyPair();
    axiosMock.post.mockResolvedValueOnce({
      data: { transactionId: "eco-txn-3", resultCode: "0" },
    });
    const adapter = new EcoCashAdapter({ ...adapterConfig, privateKey });

    const result = await adapter.sendPayout("+263771234567", "75", "ref-3");

    expect(result.success).toBe(true);
    const [, body] = axiosMock.post.mock.calls[0];
    expect(body.wallet).toBe("USD");
  });
});

describe("EcoCashAdapter.requestPayment", () => {
  it("reports as not implemented rather than silently no-op'ing", async () => {
    const adapter = new EcoCashAdapter(adapterConfig);
    const result = await adapter.requestPayment();
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("not implemented");
  });
});

describe("EcoCashAdapter.getTransactionStatus", () => {
  const adapter = new EcoCashAdapter(adapterConfig);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["SUCCESS", "completed"],
    ["COMPLETED", "completed"],
    ["FAILED", "failed"],
    ["PENDING", "pending"],
    ["SOMETHING_ELSE", "unknown"],
  ])("maps provider status %s to %s", async (providerStatus, expected) => {
    axiosMock.get.mockResolvedValueOnce({ data: { status: providerStatus } });

    const result = await adapter.getTransactionStatus("ref-1");

    expect(result.status).toBe(expected);
  });

  it("returns unknown when the status query fails with a non-retryable error", async () => {
    axiosMock.get.mockRejectedValueOnce(new Error("network error"));

    const result = await adapter.getTransactionStatus("ref-1");

    expect(result.status).toBe("unknown");
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 504 from the status endpoint via retryWithJitter (#2367), then resolves", async () => {
    jest.useFakeTimers();
    try {
      axiosMock.get
        .mockRejectedValueOnce(
          Object.assign(new Error("Gateway Timeout"), {
            response: { status: 504 },
          }),
        )
        .mockResolvedValueOnce({ data: { status: "SUCCESS" } });

      const resultPromise = adapter.getTransactionStatus("ref-retry");
      // Let the retry's backoff sleep elapse (max possible delay is 10s).
      await jest.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.status).toBe("completed");
      expect(axiosMock.get).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("gives up and returns unknown after exhausting retries on a persistent 502", async () => {
    jest.useFakeTimers();
    try {
      axiosMock.get.mockRejectedValue(
        Object.assign(new Error("Bad Gateway"), {
          response: { status: 502 },
        }),
      );

      const resultPromise = adapter.getTransactionStatus("ref-persistent");
      await jest.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      expect(result.status).toBe("unknown");
      // Default retryWithJitter: 1 initial attempt + 3 retries = 4 calls.
      expect(axiosMock.get).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });
});
