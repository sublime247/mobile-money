/**
 * Unit tests for the responseTime middleware — issue #2287
 */

import { Request, Response, NextFunction } from "express";
import { responseTime } from "../responseTime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(): Request {
  return {
    method: "GET",
    originalUrl: "/api/v1/transactions",
    url: "/api/v1/transactions",
  } as unknown as Request;
}

function makeRes(): Response & {
  _headers: Record<string, string>;
  _writeHeadArgs: Array<[number, ...any[]]>;
  writeHead: jest.Mock;
  setHeader: jest.Mock;
} {
  const _headers: Record<string, string> = {};
  const _writeHeadArgs: Array<[number, ...any[]]> = [];

  const res: any = {
    _headers,
    _writeHeadArgs,
    setHeader: jest.fn((name: string, value: string) => {
      _headers[name] = value;
    }),
    writeHead: jest.fn(function (statusCode: number, ...args: any[]) {
      _writeHeadArgs.push([statusCode, ...args]);
    }),
  };

  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("responseTime middleware", () => {
  it("calls next()", () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    responseTime(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error
  });

  it("injects X-Response-Time header when writeHead is called", () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    responseTime(req, res, next);

    // Trigger the intercepted writeHead
    (res as any).writeHead(200);

    expect(res.setHeader).toHaveBeenCalledWith(
      "X-Response-Time",
      expect.stringMatching(/^\d+\.\d+ms$/),
    );
  });

  it("X-Response-Time value is a non-negative number of milliseconds", () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    responseTime(req, res, next);
    (res as any).writeHead(200);

    const header = res._headers["X-Response-Time"];
    expect(header).toBeDefined();

    const ms = parseFloat(header);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("passes statusCode through to the original writeHead", () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    responseTime(req, res, next);
    (res as any).writeHead(404);

    expect(res._writeHeadArgs[0][0]).toBe(404);
  });

  it("still sets header for 5xx responses", () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    responseTime(req, res, next);
    (res as any).writeHead(500);

    expect(res._headers["X-Response-Time"]).toMatch(/^\d+\.\d+ms$/);
  });

  it("measures elapsed time using high-resolution timer", async () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    responseTime(req, res, next);

    // Wait a known amount of time to ensure the timer captures it
    await new Promise((resolve) => setTimeout(resolve, 20));

    (res as any).writeHead(200);

    const header = res._headers["X-Response-Time"];
    const ms = parseFloat(header);
    // Should be at least 15ms (allowing for timer imprecision in CI)
    expect(ms).toBeGreaterThanOrEqual(10);
  });

  it("emits a warning when request exceeds SLA threshold", async () => {
    const originalEnv = process.env.RESPONSE_TIME_SLA_MS;
    process.env.RESPONSE_TIME_SLA_MS = "1"; // set threshold to 1 ms so any request breaches it

    // We need to re-require the middleware so it picks up the new env value
    jest.resetModules();
    const { responseTime: rt } = await import("../responseTime");

    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();
    const warnSpy = jest.spyOn(
      require("../../utils/logger").default,
      "warn",
    );

    rt(req, res, next);

    await new Promise((resolve) => setTimeout(resolve, 5));
    (res as any).writeHead(200);

    // The warn should have been called with SLA breach message
    const wasCalled = warnSpy.mock.calls.some((args) =>
      JSON.stringify(args).includes("SLA breach"),
    );
    expect(wasCalled).toBe(true);

    warnSpy.mockRestore();
    if (originalEnv !== undefined) {
      process.env.RESPONSE_TIME_SLA_MS = originalEnv;
    } else {
      delete process.env.RESPONSE_TIME_SLA_MS;
    }
  });

  it("does NOT warn when request is within SLA", async () => {
    // Use a very large threshold so it is never breached
    const originalEnv = process.env.RESPONSE_TIME_SLA_MS;
    process.env.RESPONSE_TIME_SLA_MS = "999999";

    jest.resetModules();
    const { responseTime: rt } = await import("../responseTime");

    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();
    const warnSpy = jest.spyOn(
      require("../../utils/logger").default,
      "warn",
    );

    rt(req, res, next);
    (res as any).writeHead(200);

    const wasCalled = warnSpy.mock.calls.some((args) =>
      JSON.stringify(args).includes("SLA breach"),
    );
    expect(wasCalled).toBe(false);

    warnSpy.mockRestore();
    if (originalEnv !== undefined) {
      process.env.RESPONSE_TIME_SLA_MS = originalEnv;
    } else {
      delete process.env.RESPONSE_TIME_SLA_MS;
    }
  });
});
