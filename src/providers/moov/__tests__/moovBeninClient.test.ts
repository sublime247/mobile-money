import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import request from "supertest";
import express from "express";
import {
  buildSignaturePayload,
  isValidBeninMsisdn,
  mapMoovBeninStatus,
  MoovBeninClient,
  normalizeBeninMsisdn,
  signMoovBeninPayload,
} from "../moovBeninClient";
import { createMoovRouter } from "../../../routes/moovRoutes";

jest.mock("axios");
const axiosMock = axios as jest.Mocked<typeof axios>;

const FIXED_NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const TIMESTAMP = new Date(FIXED_NOW).toISOString();

const config = {
  baseUrl: "https://moov-bj.example.test",
  merchantId: "MERCHANT-42",
  apiKey: "api-key",
  signingSecret: "s3cret",
  pushPath: "/api/v1/collections/push",
  statusPath: "/api/v1/collections/{reference}/status",
  timeoutMs: 5_000,
  now: () => FIXED_NOW,
};

function axiosError(
  status?: number,
  data?: Record<string, unknown>,
  code?: string,
): AxiosError {
  const cfg = {} as InternalAxiosRequestConfig;
  const response = status
    ? ({ status, statusText: "", headers: {}, config: cfg, data } as never)
    : undefined;
  return new AxiosError("Request failed", code ?? String(status), cfg, {}, response);
}

beforeEach(() => jest.clearAllMocks());

describe("MSISDN helpers", () => {
  it("prefixes local Benin numbers with 229", () => {
    expect(normalizeBeninMsisdn("97 00 00 00")).toBe("22997000000");
    expect(normalizeBeninMsisdn("+229 01 97 00 00 00")).toBe("2290197000000");
    expect(normalizeBeninMsisdn("0022997000000")).toBe("22997000000");
  });

  it("accepts legacy 8-digit and new 01-prefixed 10-digit numbers only", () => {
    expect(isValidBeninMsisdn("+22997000000")).toBe(true);
    expect(isValidBeninMsisdn("0197000000")).toBe(true);
    expect(isValidBeninMsisdn("+2289000000")).toBe(false);
    expect(isValidBeninMsisdn("123")).toBe(false);
  });
});

describe("mapMoovBeninStatus", () => {
  it.each([
    ["SUCCESS", "SUCCESSFUL"],
    ["0", "SUCCESSFUL"],
    ["PENDING", "PENDING"],
    ["USER_REJECTED", "REJECTED"],
    ["17", "REJECTED"],
    ["TIMEOUT", "EXPIRED"],
    ["INSUFFICIENT_BALANCE", "FAILED"],
    [undefined, "UNKNOWN"],
  ])("maps %s to %s", (raw, expected) => {
    expect(mapMoovBeninStatus(raw)).toBe(expected);
  });
});

describe("MoovBeninClient.initiatePush", () => {
  it("sends a signed push USSD request and assigns a tracking reference", async () => {
    axiosMock.post.mockResolvedValueOnce({
      status: 200,
      data: { status: "PENDING", transactionId: "MOOV-TX-1", responseCode: "100" },
    });
    const client = new MoovBeninClient(config);

    const result = await client.initiatePush({
      phoneNumber: "97000000",
      amount: 5000,
      reference: "REF-1",
    });

    expect(result).toEqual({
      accepted: true,
      status: "PENDING",
      trackingReference: "REF-1",
      providerTransactionId: "MOOV-TX-1",
      providerCode: "100",
      message: undefined,
      retryable: false,
    });

    const [url, body, options] = axiosMock.post.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { headers: Record<string, string>; timeout: number },
    ];
    expect(url).toBe("https://moov-bj.example.test/api/v1/collections/push");
    expect(body).toMatchObject({
      merchantId: "MERCHANT-42",
      reference: "REF-1",
      msisdn: "22997000000",
      amount: 5000,
      currency: "XOF",
      timestamp: TIMESTAMP,
    });

    const expectedSignature = signMoovBeninPayload(
      buildSignaturePayload({
        merchantId: "MERCHANT-42",
        reference: "REF-1",
        msisdn: "22997000000",
        amount: 5000,
        currency: "XOF",
        timestamp: TIMESTAMP,
      }),
      "s3cret",
    );
    expect(options.headers["X-Signature"]).toBe(expectedSignature);
    expect(options.headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(options.headers["X-Merchant-Id"]).toBe("MERCHANT-42");
    expect(options.headers["X-Timestamp"]).toBe(TIMESTAMP);
    expect(options.headers.Authorization).toBe("Bearer api-key");
    expect(options.timeout).toBe(5_000);
  });

  it("generates a tracking reference when none is supplied", async () => {
    axiosMock.post.mockResolvedValueOnce({ status: 200, data: { status: "ACCEPTED" } });
    const result = await new MoovBeninClient(config).initiatePush({
      phoneNumber: "+22997000000",
      amount: 100,
    });
    expect(result.trackingReference).toMatch(/^MOOVBJ-[0-9a-f-]{36}$/);
    expect(result.accepted).toBe(true);
  });

  it("reports an immediate customer/gateway rejection as not accepted", async () => {
    axiosMock.post.mockRejectedValueOnce(
      axiosError(400, { status: "REJECTED", responseCode: "17", message: "Subscriber declined" }),
    );
    const result = await new MoovBeninClient(config).initiatePush({
      phoneNumber: "97000000",
      amount: 5000,
      reference: "REF-2",
    });
    expect(result).toMatchObject({
      accepted: false,
      status: "REJECTED",
      trackingReference: "REF-2",
      providerCode: "17",
      message: "Subscriber declined",
      retryable: false,
    });
  });

  it("returns UNKNOWN with timedOut on a gateway timeout instead of re-sending", async () => {
    axiosMock.post.mockRejectedValueOnce(axiosError(undefined, undefined, "ECONNABORTED"));
    const result = await new MoovBeninClient(config).initiatePush({
      phoneNumber: "97000000",
      amount: 5000,
      reference: "REF-3",
    });
    expect(result).toMatchObject({
      accepted: false,
      status: "UNKNOWN",
      timedOut: true,
      retryable: true,
      trackingReference: "REF-3",
    });
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
  });

  it("treats an HTTP 504 from the gateway as a timeout", async () => {
    axiosMock.post.mockRejectedValueOnce(axiosError(504));
    const result = await new MoovBeninClient(config).initiatePush({
      phoneNumber: "97000000",
      amount: 5000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.status).toBe("UNKNOWN");
  });

  it("rejects non-Benin numbers and invalid amounts without calling Moov", async () => {
    const client = new MoovBeninClient(config);
    expect((await client.initiatePush({ phoneNumber: "+22890123456", amount: 100 })).accepted).toBe(false);
    expect((await client.initiatePush({ phoneNumber: "97000000", amount: 10.5 })).accepted).toBe(false);
    expect((await client.initiatePush({ phoneNumber: "97000000", amount: 0 })).accepted).toBe(false);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });
});

describe("MoovBeninClient.checkStatus", () => {
  it("reports customer authorisation as a final SUCCESSFUL status", async () => {
    axiosMock.get.mockResolvedValueOnce({
      status: 200,
      data: { status: "SUCCESS", transactionId: "MOOV-TX-1" },
    });
    const result = await new MoovBeninClient(config).checkStatus("REF-1");

    expect(result).toMatchObject({
      trackingReference: "REF-1",
      status: "SUCCESSFUL",
      final: true,
      providerTransactionId: "MOOV-TX-1",
    });
    const [url, options] = axiosMock.get.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe("https://moov-bj.example.test/api/v1/collections/REF-1/status");
    expect(options.headers["X-Signature"]).toBe(
      signMoovBeninPayload(
        buildSignaturePayload({ merchantId: "MERCHANT-42", reference: "REF-1", timestamp: TIMESTAMP }),
        "s3cret",
      ),
    );
  });

  it("reports customer rejection as a final REJECTED status", async () => {
    axiosMock.get.mockResolvedValueOnce({ status: 200, data: { status: "USER_REJECTED" } });
    const result = await new MoovBeninClient(config).checkStatus("REF-2");
    expect(result).toMatchObject({ status: "REJECTED", final: true });
  });

  it("keeps a still-pending push non-final", async () => {
    axiosMock.get.mockResolvedValueOnce({ status: 200, data: { status: "PENDING" } });
    const result = await new MoovBeninClient(config).checkStatus("REF-4");
    expect(result).toMatchObject({ status: "PENDING", final: false });
  });

  it("returns a non-final UNKNOWN on gateway timeout", async () => {
    axiosMock.get.mockRejectedValueOnce(axiosError(undefined, undefined, "ETIMEDOUT"));
    const result = await new MoovBeninClient(config).checkStatus("REF-3");
    expect(result).toMatchObject({ status: "UNKNOWN", final: false, timedOut: true });
  });
});

describe("Moov routes", () => {
  function makeApp(client: any) {
    const app = express();
    app.use(express.json());
    app.use("/moov", createMoovRouter(client));
    return app;
  }

  it("POST /benin/collections returns 202 with the tracking reference", async () => {
    const client = {
      initiatePush: jest.fn().mockResolvedValue({
        accepted: true,
        status: "PENDING",
        trackingReference: "REF-1",
        retryable: false,
      }),
      checkStatus: jest.fn(),
    };
    const res = await request(makeApp(client))
      .post("/moov/benin/collections")
      .send({ phoneNumber: "97000000", amount: 5000 });
    expect(res.status).toBe(202);
    expect(res.body.trackingReference).toBe("REF-1");
    expect(client.initiatePush).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: "97000000", amount: 5000 }),
    );
  });

  it("POST /benin/collections returns 422 on a non-retryable rejection", async () => {
    const client = {
      initiatePush: jest.fn().mockResolvedValue({
        accepted: false,
        status: "REJECTED",
        trackingReference: "REF-2",
        retryable: false,
      }),
      checkStatus: jest.fn(),
    };
    const res = await request(makeApp(client))
      .post("/moov/benin/collections")
      .send({ phoneNumber: "97000000", amount: 5000 });
    expect(res.status).toBe(422);
  });

  it("POST /benin/collections validates the body", async () => {
    const client = { initiatePush: jest.fn(), checkStatus: jest.fn() };
    const res = await request(makeApp(client)).post("/moov/benin/collections").send({});
    expect(res.status).toBe(400);
    expect(client.initiatePush).not.toHaveBeenCalled();
  });

  it("GET /benin/collections/:reference/status proxies the status check", async () => {
    const client = {
      initiatePush: jest.fn(),
      checkStatus: jest.fn().mockResolvedValue({
        trackingReference: "REF-1",
        status: "SUCCESSFUL",
        final: true,
      }),
    };
    const res = await request(makeApp(client)).get("/moov/benin/collections/REF-1/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCESSFUL");
    expect(client.checkStatus).toHaveBeenCalledWith("REF-1");
  });
});
