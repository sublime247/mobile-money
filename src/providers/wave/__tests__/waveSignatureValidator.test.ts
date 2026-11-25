import { createHmac } from "crypto";
import { Request, Response, NextFunction } from "express";
import {
  WAVE_TIMESTAMP_TOLERANCE_SECONDS,
  parseWaveSignatureHeader,
  isWaveTimestampFresh,
  computeWaveExpectedSignature,
  compareWaveSignatures,
  verifyWaveSignature,
} from "../waveSignatureValidator";

// ─── helpers ─────────────────────────────────────────────────────────────────

const SECRET = "test-wave-secret-32-bytes-padding!";

function makeSignature(timestamp: string, body: string): string {
  const digest = createHmac("sha256", SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function makeReq(
  overrides: Partial<Request> & { rawBody?: Buffer } = {},
): Request {
  return {
    headers: {},
    body: {},
    method: "POST",
    path: "/webhook/wave",
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const res = {
    statusCode: 200,
    _body: null as unknown,
    status: jest.fn().mockImplementation(function (this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn().mockImplementation(function (this: any, body: unknown) {
      this._body = body;
      return this;
    }),
  };
  return res;
}

// ─── parseWaveSignatureHeader ─────────────────────────────────────────────────

describe("parseWaveSignatureHeader", () => {
  it("parses a well-formed header", () => {
    const result = parseWaveSignatureHeader("t=1700000000,v1=abcdef");
    expect(result).toEqual({ timestamp: "1700000000", v1: "abcdef" });
  });

  it("returns null for an absent header", () => {
    expect(parseWaveSignatureHeader(undefined)).toBeNull();
  });

  it("returns null when timestamp is missing", () => {
    expect(parseWaveSignatureHeader("v1=abcdef")).toBeNull();
  });

  it("returns null when digest is missing", () => {
    expect(parseWaveSignatureHeader("t=1700000000")).toBeNull();
  });

  it("handles extra whitespace around the equals sign", () => {
    const result = parseWaveSignatureHeader("t = 1700000000 , v1 = abcdef");
    expect(result).toEqual({ timestamp: "1700000000", v1: "abcdef" });
  });
});

// ─── isWaveTimestampFresh ─────────────────────────────────────────────────────

describe("isWaveTimestampFresh", () => {
  it("accepts a timestamp from 1 second ago", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 1);
    expect(isWaveTimestampFresh(ts)).toBe(true);
  });

  it("accepts a timestamp exactly at the tolerance boundary", () => {
    // Subtract 1 from tolerance to avoid a race if the wall clock ticks
    // between this line and the comparison inside isWaveTimestampFresh.
    const ts = String(
      Math.floor(Date.now() / 1000) - WAVE_TIMESTAMP_TOLERANCE_SECONDS + 1,
    );
    expect(isWaveTimestampFresh(ts)).toBe(true);
  });

  it("rejects a timestamp 1 second past the tolerance boundary", () => {
    const ts = String(
      Math.floor(Date.now() / 1000) - WAVE_TIMESTAMP_TOLERANCE_SECONDS - 1,
    );
    expect(isWaveTimestampFresh(ts)).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(isWaveTimestampFresh("not-a-number")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isWaveTimestampFresh("")).toBe(false);
  });
});

// ─── computeWaveExpectedSignature ────────────────────────────────────────────

describe("computeWaveExpectedSignature", () => {
  it("produces the same digest for Buffer and string bodies", () => {
    const ts = "1700000000";
    const body = '{"amount":"500"}';
    const fromBuffer = computeWaveExpectedSignature(ts, Buffer.from(body), SECRET);
    const fromString = computeWaveExpectedSignature(ts, body, SECRET);
    expect(fromBuffer).toBe(fromString);
  });

  it("changes when the body is tampered", () => {
    const ts = "1700000000";
    const original = computeWaveExpectedSignature(ts, '{"amount":"500"}', SECRET);
    const tampered = computeWaveExpectedSignature(ts, '{"amount":"999"}', SECRET);
    expect(original).not.toBe(tampered);
  });
});

// ─── compareWaveSignatures ────────────────────────────────────────────────────

describe("compareWaveSignatures", () => {
  it("returns true for identical digests", () => {
    const digest = "a".repeat(64);
    expect(compareWaveSignatures(digest, digest)).toBe(true);
  });

  it("returns false for different digests of the same length", () => {
    expect(compareWaveSignatures("a".repeat(64), "b".repeat(64))).toBe(false);
  });

  it("returns false for digests with different lengths", () => {
    expect(compareWaveSignatures("abc", "abcd")).toBe(false);
  });
});

// ─── verifyWaveSignature middleware ──────────────────────────────────────────

describe("verifyWaveSignature middleware", () => {
  const BODY = '{"type":"checkout.session.completed"}';

  beforeEach(() => {
    process.env.WAVE_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.WAVE_WEBHOOK_SECRET;
  });

  it("calls next() for a valid signature and fresh timestamp", () => {
    const ts = nowSeconds();
    const sig = makeSignature(ts, BODY);
    const req = makeReq({
      headers: { "wave-signature": sig },
      rawBody: Buffer.from(BODY),
    });
    const res = makeRes();
    const next = jest.fn();

    verifyWaveSignature(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when the signature header is absent", () => {
    const req = makeReq({ rawBody: Buffer.from(BODY) });
    const res = makeRes();
    const next = jest.fn();

    verifyWaveSignature(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the body has been tampered", () => {
    const ts = nowSeconds();
    const sig = makeSignature(ts, BODY);
    const tamperedBody = Buffer.from(BODY + ',"extra":"injected"}');
    const req = makeReq({
      headers: { "wave-signature": sig },
      rawBody: tamperedBody,
    });
    const res = makeRes();
    const next = jest.fn();

    verifyWaveSignature(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the timestamp is older than 300 seconds", () => {
    const staleTs = String(
      Math.floor(Date.now() / 1000) - WAVE_TIMESTAMP_TOLERANCE_SECONDS - 10,
    );
    const sig = makeSignature(staleTs, BODY);
    const req = makeReq({
      headers: { "wave-signature": sig },
      rawBody: Buffer.from(BODY),
    });
    const res = makeRes();
    const next = jest.fn();

    verifyWaveSignature(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("returns 500 when WAVE_WEBHOOK_SECRET is not configured", () => {
    delete process.env.WAVE_WEBHOOK_SECRET;
    const ts = nowSeconds();
    const sig = makeSignature(ts, BODY);
    const req = makeReq({
      headers: { "wave-signature": sig },
      rawBody: Buffer.from(BODY),
    });
    const res = makeRes();
    const next = jest.fn();

    verifyWaveSignature(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
  });
});
