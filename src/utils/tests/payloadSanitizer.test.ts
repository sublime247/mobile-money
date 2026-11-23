import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import {
  MASK,
  MAX_PAYLOAD_BYTES,
  TRUNCATION_MARKER,
  isSensitiveField,
  limitPayloadSize,
  sanitizeAndLimit,
  sanitizePayload,
  sanitizeUrl,
} from "../payloadSanitizer";

jest.mock("../../config/database", () => ({ queryWrite: jest.fn() }));
jest.mock("../../middleware/correlationId", () => ({
  getCurrentCorrelationId: () => "corr-123",
  CORRELATION_ID_HEADER: "x-correlation-id",
}));

import {
  attachProviderErrorInterceptor,
  buildProviderErrorSnapshot,
} from "../../services/mobilemoney/providers/providerHttpClient";

describe("payloadSanitizer", () => {
  describe("isSensitiveField", () => {
    it.each([
      "pin",
      "PIN",
      "password",
      "access_token",
      "accessToken",
      "access-token",
      "national_id",
      "nationalId",
      "cvv",
      "CVV",
      "customerPin",
      "merchant_password",
      "Authorization",
      "x-api-key",
      "client_secret",
      "refresh_token",
    ])("treats %s as sensitive", (key) => {
      expect(isSensitiveField(key)).toBe(true);
    });

    it.each(["amount", "currency", "phoneNumber", "status", "shipping", "spinner", "reference"])(
      "leaves %s alone",
      (key) => {
        expect(isSensitiveField(key)).toBe(false);
      },
    );
  });

  describe("sanitizePayload", () => {
    it("masks the required credential fields and keeps the rest", () => {
      const input = {
        pin: "1234",
        password: "hunter2",
        access_token: "eyJhbGciOi.secret.token",
        national_id: "CM-1234567890",
        cvv: "123",
        amount: "5000",
        currency: "XAF",
      };

      expect(sanitizePayload(input)).toEqual({
        pin: MASK,
        password: MASK,
        access_token: MASK,
        national_id: MASK,
        cvv: MASK,
        amount: "5000",
        currency: "XAF",
      });
    });

    it("masks nested objects and arrays", () => {
      const result = sanitizePayload({
        payer: { msisdn: "237670000000", credentials: { pin: "0000" } },
        cards: [{ cvv: "999", last4: "4242" }],
      }) as any;

      expect(result.payer.msisdn).toBe("237670000000");
      expect(result.payer.credentials.pin).toBe(MASK);
      expect(result.cards[0]).toEqual({ cvv: MASK, last4: "4242" });
    });

    it("does not mutate its input", () => {
      const input = { pin: "1234", nested: { password: "x" } };
      sanitizePayload(input);
      expect(input).toEqual({ pin: "1234", nested: { password: "x" } });
    });

    it("masks fields inside JSON-encoded string bodies", () => {
      const body = JSON.stringify({ accessToken: "tok", nationalId: "ID-9", amount: 10 });
      const result = JSON.parse(sanitizePayload(body) as string);
      expect(result).toEqual({ accessToken: MASK, nationalId: MASK, amount: 10 });
    });

    it("masks fields in form-encoded bodies", () => {
      const body = "grant_type=password&username=svc&password=s3cret&pin=1234";
      expect(sanitizePayload(body)).toBe(
        `grant_type=password&username=svc&password=${MASK}&pin=${MASK}`,
      );
    });

    it("masks bearer tokens and inline credentials in free text", () => {
      const result = sanitizePayload(
        "upstream rejected Bearer abc.def.ghi with pin: 4321",
      ) as string;
      expect(result).not.toContain("abc.def.ghi");
      expect(result).not.toContain("4321");
      expect(result).toContain(`Bearer ${MASK}`);
    });

    it("masks authorization headers on AxiosHeaders instances", () => {
      const headers = new AxiosHeaders({
        Authorization: "Bearer live-token",
        "X-Api-Key": "key-1",
        "Content-Type": "application/json",
      });
      const result = sanitizePayload(headers) as Record<string, unknown>;
      expect(result.Authorization).toBe(MASK);
      expect(result["X-Api-Key"]).toBe(MASK);
      expect(result["Content-Type"]).toBe("application/json");
    });

    it("survives circular references", () => {
      const a: Record<string, unknown> = { pin: "1" };
      a.self = a;
      expect(sanitizePayload(a)).toEqual({ pin: MASK, self: "[CIRCULAR]" });
    });
  });

  describe("sanitizeUrl", () => {
    it("masks sensitive query parameters", () => {
      expect(
        sanitizeUrl("https://api.example.com/pay?msisdn=2376&access_token=abc&pin=1#x"),
      ).toBe(
        `https://api.example.com/pay?msisdn=2376&access_token=${MASK}&pin=${MASK}#x`,
      );
    });

    it("returns URLs without a query unchanged", () => {
      expect(sanitizeUrl("https://api.example.com/pay")).toBe(
        "https://api.example.com/pay",
      );
    });
  });

  describe("limitPayloadSize", () => {
    it("keeps payloads under the 32KB limit intact", () => {
      const payload = { data: "a".repeat(1000) };
      expect(limitPayloadSize(payload)).toEqual({
        payload,
        truncated: false,
        originalBytes: JSON.stringify(payload).length,
      });
    });

    it("truncates payloads over 32KB", () => {
      const payload = { data: "a".repeat(MAX_PAYLOAD_BYTES * 2) };
      const result = limitPayloadSize(payload);

      expect(result.truncated).toBe(true);
      expect(result.originalBytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
      expect(typeof result.payload).toBe("string");
      expect(Buffer.byteLength(result.payload as string, "utf8")).toBeLessThanOrEqual(
        MAX_PAYLOAD_BYTES,
      );
      expect(result.payload as string).toMatch(/\.\.\.\[TRUNCATED\]$/);
    });

    it("does not split multi-byte characters", () => {
      const result = limitPayloadSize("é".repeat(100), 51);
      expect(result.truncated).toBe(true);
      expect(result.payload as string).not.toContain("�");
      expect((result.payload as string).endsWith(TRUNCATION_MARKER)).toBe(true);
    });

    it("sanitizes before truncating so secrets never survive the cut", () => {
      const payload = { pin: "9876", blob: "x".repeat(MAX_PAYLOAD_BYTES) };
      const result = sanitizeAndLimit(payload);
      expect(result.truncated).toBe(true);
      expect(result.payload as string).not.toContain("9876");
    });
  });
});

describe("provider failure interceptor", () => {
  function makeError(): AxiosError {
    const config = {
      method: "post",
      baseURL: "https://provider.example.com",
      url: "/v1/collect?access_token=raw-token",
      headers: new AxiosHeaders({
        Authorization: "Bearer provider-token",
        "Content-Type": "application/json",
      }),
      data: JSON.stringify({ pin: "1234", national_id: "NID-1", amount: "500" }),
    } as InternalAxiosRequestConfig;

    return new AxiosError("Request failed with status code 401", "ERR_BAD_REQUEST", config, {}, {
      status: 401,
      statusText: "Unauthorized",
      headers: { "set-cookie": "session=abc", "content-type": "application/json" },
      config,
      data: { error: "invalid_pin", password: "echoed-back" },
    });
  }

  it("builds a fully redacted snapshot of the failed call", () => {
    const snapshot = buildProviderErrorSnapshot("mtn", makeError());
    const serialized = JSON.stringify(snapshot);

    expect(snapshot).toMatchObject({
      provider: "mtn",
      method: "POST",
      statusCode: 401,
      errorCode: "ERR_BAD_REQUEST",
      payloadTruncated: false,
      correlationId: "corr-123",
    });
    expect(snapshot.url).toBe(
      `https://provider.example.com/v1/collect?access_token=${MASK}`,
    );
    expect(snapshot.requestBody).toEqual({ pin: MASK, national_id: MASK, amount: "500" });
    expect(snapshot.responseBody).toEqual({ error: "invalid_pin", password: MASK });

    for (const secret of ["provider-token", "raw-token", "1234", "NID-1", "echoed-back", "session=abc"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("records the snapshot and re-throws the original error", async () => {
    const handlers: { rejected?: (e: unknown) => unknown } = {};
    const client: any = {
      interceptors: {
        request: { use: jest.fn() },
        response: {
          use: jest.fn((_ok, rejected) => {
            handlers.rejected = rejected;
          }),
        },
      },
    };
    const recorder = jest.fn().mockResolvedValue(undefined);
    attachProviderErrorInterceptor(client, "orange", { recorder });

    const error = makeError();
    await expect(handlers.rejected!(error)).rejects.toBe(error);
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder.mock.calls[0][0].provider).toBe("orange");
    expect(JSON.stringify(recorder.mock.calls[0][0])).not.toContain("1234");
  });

  it("still re-throws when the recorder fails", async () => {
    const handlers: { rejected?: (e: unknown) => unknown } = {};
    const client: any = {
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn((_ok, rejected) => (handlers.rejected = rejected)) },
      },
    };
    attachProviderErrorInterceptor(client, "airtel", {
      recorder: jest.fn().mockRejectedValue(new Error("db down")),
    });

    const error = makeError();
    await expect(handlers.rejected!(error)).rejects.toBe(error);
  });
});
