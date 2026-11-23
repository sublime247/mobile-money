/**
 * Unit tests for apiVersionMiddleware — X-API-Version header routing.
 * Issue #2285
 */

import { Request, Response } from "express";
import {
  apiVersionMiddleware,
  validateVersionMiddleware,
  CURRENT_VERSION,
  SUPPORTED_VERSIONS,
  DEPRECATED_VERSIONS,
  X_API_VERSION_HEADER,
  VersionedRequest,
} from "../apiVersion";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<{
  path: string;
  headers: Record<string, string>;
}>): VersionedRequest {
  const { path = "/health", headers = {} } = overrides;
  return {
    path,
    originalUrl: path,
    get: (name: string) => headers[name.toLowerCase()] ?? undefined,
  } as unknown as VersionedRequest;
}

function makeRes(): Response & {
  _headers: Record<string, string | string[]>;
  _varied: string[];
} {
  const _headers: Record<string, string | string[]> = {};
  const _varied: string[] = [];
  return {
    _headers,
    _varied,
    setHeader(name: string, value: string) {
      _headers[name] = value;
    },
    vary(field: string) {
      _varied.push(field);
    },
  } as unknown as Response & { _headers: Record<string, string | string[]>; _varied: string[] };
}

// ---------------------------------------------------------------------------
// apiVersionMiddleware — X-API-Version header (issue #2285)
// ---------------------------------------------------------------------------

describe("apiVersionMiddleware — X-API-Version header routing", () => {
  it("reads version from X-API-Version header", () => {
    const req = makeReq({ headers: { [X_API_VERSION_HEADER]: "v1" } });
    const res = makeRes();
    const next = jest.fn();

    apiVersionMiddleware(req, res, next);

    expect(req.apiVersion).toBe("v1");
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error
  });

  it("accepts numeric version string without 'v' prefix in X-API-Version", () => {
    const req = makeReq({ headers: { [X_API_VERSION_HEADER]: "1" } });
    const res = makeRes();
    const next = jest.fn();

    apiVersionMiddleware(req, res, next);

    expect(req.apiVersion).toBe("v1");
  });

  it("defaults to CURRENT_VERSION when X-API-Version is absent", () => {
    const req = makeReq({});
    const res = makeRes();
    const next = jest.fn();

    apiVersionMiddleware(req, res, next);

    expect(req.apiVersion).toBe(CURRENT_VERSION);
    expect(next).toHaveBeenCalledWith();
  });

  it("defaults to CURRENT_VERSION when header value is empty string", () => {
    const req = makeReq({ headers: { [X_API_VERSION_HEADER]: "" } });
    const res = makeRes();
    const next = jest.fn();

    apiVersionMiddleware(req, res, next);

    // empty string fails normalizeApiVersion → falls back to default
    expect(req.apiVersion).toBe(CURRENT_VERSION);
  });

  it("sets API-Version response header", () => {
    const req = makeReq({ headers: { [X_API_VERSION_HEADER]: "v1" } });
    const res = makeRes();
    const next = jest.fn();

    apiVersionMiddleware(req, res, next);

    expect(res._headers["API-Version"]).toBe("v1");
  });

  it("adds X-API-Version to Vary response header", () => {
    const req = makeReq({ headers: { [X_API_VERSION_HEADER]: "v1" } });
    const res = makeRes();
    const next = jest.fn();

    apiVersionMiddleware(req, res, next);

    expect(res._varied).toContain(X_API_VERSION_HEADER);
  });

  it("URL path takes priority over X-API-Version header", () => {
    const req = makeReq({
      path: "/api/v1/transactions",
      headers: { [X_API_VERSION_HEADER]: "v2" }, // header says v2 but path says v1
    });
    const res = makeRes();
    const next = jest.fn();

    apiVersionMiddleware(req, res, next);

    expect(req.apiVersion).toBe("v1"); // path wins
  });

  it("X-API-Version takes priority over Accept-Version", () => {
    const req = makeReq({
      headers: {
        [X_API_VERSION_HEADER]: "v1",
        "accept-version": "v2",
      },
    });
    const res = makeRes();
    const next = jest.fn();

    apiVersionMiddleware(req, res, next);

    expect(req.apiVersion).toBe("v1");
  });

  it("falls back to Accept-Version when X-API-Version is absent", () => {
    const req = makeReq({ headers: { "accept-version": "v1" } });
    const res = makeRes();
    const next = jest.fn();

    apiVersionMiddleware(req, res, next);

    expect(req.apiVersion).toBe("v1");
  });

  it("attaches Deprecation header for deprecated version via X-API-Version", () => {
    // Temporarily mark v1 as deprecated for this test
    DEPRECATED_VERSIONS.push("v1");
    try {
      const req = makeReq({ headers: { [X_API_VERSION_HEADER]: "v1" } });
      const res = makeRes();
      const next = jest.fn();

      apiVersionMiddleware(req, res, next);

      expect(res._headers["Deprecation"]).toBe("true");
      expect(res._headers["Sunset"]).toBeDefined();
      expect(res._headers["Link"]).toMatch(/latest-version/);
    } finally {
      // cleanup — remove v1 from deprecated list
      const idx = DEPRECATED_VERSIONS.indexOf("v1");
      if (idx !== -1) DEPRECATED_VERSIONS.splice(idx, 1);
    }
  });

  it("does NOT attach Deprecation header for a non-deprecated version", () => {
    const req = makeReq({ headers: { [X_API_VERSION_HEADER]: "v1" } });
    const res = makeRes();
    const next = jest.fn();

    apiVersionMiddleware(req, res, next);

    expect(res._headers["Deprecation"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateVersionMiddleware
// ---------------------------------------------------------------------------

describe("validateVersionMiddleware", () => {
  it("calls next() for a supported version", () => {
    const req = makeReq({}) as VersionedRequest;
    req.apiVersion = SUPPORTED_VERSIONS[0];
    const res = makeRes() as unknown as Response & { status: jest.Mock; json: jest.Mock };
    (res as any).status = jest.fn().mockReturnThis();
    (res as any).json = jest.fn().mockReturnThis();
    const next = jest.fn();

    validateVersionMiddleware(req, res as any, next);

    expect(next).toHaveBeenCalledWith();
    expect((res as any).status).not.toHaveBeenCalled();
  });

  it("returns 400 for an unsupported version", () => {
    const req = makeReq({}) as VersionedRequest;
    req.apiVersion = "v99";
    const res = makeRes() as unknown as Response & { status: jest.Mock; json: jest.Mock };
    (res as any).status = jest.fn().mockReturnThis();
    (res as any).json = jest.fn().mockReturnThis();
    const next = jest.fn();

    validateVersionMiddleware(req, res as any, next);

    expect((res as any).status).toHaveBeenCalledWith(400);
    expect((res as any).json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Unsupported API Version" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("defaults to CURRENT_VERSION when apiVersion is undefined", () => {
    const req = makeReq({}) as VersionedRequest;
    // apiVersion intentionally not set
    const res = makeRes() as unknown as Response & { status: jest.Mock; json: jest.Mock };
    (res as any).status = jest.fn().mockReturnThis();
    (res as any).json = jest.fn().mockReturnThis();
    const next = jest.fn();

    validateVersionMiddleware(req, res as any, next);

    // CURRENT_VERSION is supported, so next() is called
    expect(next).toHaveBeenCalledWith();
  });
});
