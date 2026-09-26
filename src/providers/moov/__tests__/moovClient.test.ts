import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { MoovClient, normalizeMsisdn, validateMsisdn } from "../moovClient";

jest.mock("axios");
const axiosMock = axios as jest.Mocked<typeof axios>;

jest.mock("../../../utils/circuitBreaker", () => ({
  // The circuit breaker itself (opossum config, provider health checks,
  // DB-backed settings) is out of scope for this client's own tests --
  // pass through directly to `execute` so these tests exercise MoovClient's
  // request formatting and error mapping, not breaker behavior.
  executeWithCircuitBreaker: jest.fn(async ({ execute }: any) => execute()),
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

const clientConfig = {
  baseUrl: "https://moov.example.test",
  apiKey: "test-api-key",
  collectionPath: "/v1/collections/ussd-push",
  timeoutMs: 5_000,
};

describe("normalizeMsisdn", () => {
  it("normalizes a Benin number with a + prefix", () => {
    expect(normalizeMsisdn("+22961234567")).toBe("22961234567");
  });

  it("normalizes a Togo number with leading zeros stripped by digits-only extraction", () => {
    expect(normalizeMsisdn("228 90 12 34 56")).toBe("22890123456");
  });

  it("normalizes a Côte d'Ivoire number already digits-only", () => {
    expect(normalizeMsisdn("225070000000")).toBe("225070000000");
  });

  it("returns raw digits for a number with no recognized country code", () => {
    expect(normalizeMsisdn("+15551234567")).toBe("15551234567");
  });
});

describe("validateMsisdn", () => {
  it.each(["+22961234567", "+22890123456", "+225070000000"])(
    "accepts a valid supported-country MSISDN %s",
    (phone) => {
      expect(validateMsisdn(phone)).toBe(true);
    },
  );

  it("rejects an unsupported country code", () => {
    expect(validateMsisdn("+15551234567")).toBe(false);
  });

  it("rejects a too-short number", () => {
    expect(validateMsisdn("+22912")).toBe(false);
  });
});

describe("MoovClient.requestCollection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("formats the USSD collection request with MSISDN and XOF amount", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { status: "ACCEPTED", transactionId: "moov-txn-1" },
    });
    const client = new MoovClient(clientConfig);

    const result = await client.requestCollection({
      phoneNumber: "+22961234567",
      amount: 5000,
      requestId: "req-1",
    });

    expect(result).toEqual({
      success: true,
      status: "ACCEPTED",
      referenceId: "req-1",
      providerTransactionId: "moov-txn-1",
    });
    expect(axiosMock.post).toHaveBeenCalledWith(
      "https://moov.example.test/v1/collections/ussd-push",
      {
        msisdn: "22961234567",
        amount: 5000,
        currency: "XOF",
        referenceId: "req-1",
      },
      {
        headers: {
          Authorization: "Bearer test-api-key",
          "Content-Type": "application/json",
        },
        timeout: 5_000,
      },
    );
  });

  it("handles the synchronous PENDING accepted response", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { status: "PENDING" },
    });
    const client = new MoovClient(clientConfig);

    const result = await client.requestCollection({
      phoneNumber: "+22890123456",
      amount: 2500,
    });

    expect(result.success).toBe(true);
    expect((result as any).status).toBe("PENDING");
  });

  it("rejects with a friendly message for an unsupported MSISDN without calling the API", async () => {
    const client = new MoovClient(clientConfig);

    const result = await client.requestCollection({
      phoneNumber: "+15551234567",
      amount: 1000,
    });

    expect(result.success).toBe(false);
    expect((result as any).error).toContain("Benin (229), Togo (228)");
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount without calling the API", async () => {
    const client = new MoovClient(clientConfig);

    const result = await client.requestCollection({
      phoneNumber: "+22961234567",
      amount: 0,
    });

    expect(result.success).toBe(false);
    expect((result as any).error).toContain("positive number of XOF");
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("maps INSUFFICIENT_BALANCE to a friendly, non-retryable error", async () => {
    axiosMock.post.mockRejectedValueOnce(
      createMockAxiosError(400, { code: "INSUFFICIENT_BALANCE" }),
    );
    const client = new MoovClient(clientConfig);

    const result = await client.requestCollection({
      phoneNumber: "+22961234567",
      amount: 5000,
    });

    expect(result.success).toBe(false);
    expect((result as any).error).toBe(
      "Insufficient balance in the Moov Money account",
    );
    expect((result as any).providerErrorCode).toBe("INSUFFICIENT_BALANCE");
    expect((result as any).retryable).toBe(false);
  });

  it("maps PIN_TIMEOUT to a friendly, retryable error", async () => {
    axiosMock.post.mockRejectedValueOnce(
      createMockAxiosError(408, { code: "PIN_TIMEOUT" }),
    );
    const client = new MoovClient(clientConfig);

    const result = await client.requestCollection({
      phoneNumber: "+22961234567",
      amount: 5000,
    });

    expect(result.success).toBe(false);
    expect((result as any).error).toBe(
      "Customer did not enter their PIN in time on the USSD prompt",
    );
    expect((result as any).retryable).toBe(true);
  });

  it("falls back to a generic message for an unrecognized error code", async () => {
    axiosMock.post.mockRejectedValueOnce(
      createMockAxiosError(400, { code: "SOME_NEW_UNMAPPED_CODE" }),
    );
    const client = new MoovClient(clientConfig);

    const result = await client.requestCollection({
      phoneNumber: "+22961234567",
      amount: 5000,
    });

    expect(result.success).toBe(false);
    expect((result as any).error).toBe("Moov USSD collection request failed");
    expect((result as any).retryable).toBe(false);
  });
});
