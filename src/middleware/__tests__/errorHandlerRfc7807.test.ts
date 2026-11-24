/**
 * Unit tests verifying RFC-7807 Problem Details responses from errorHandler.
 * Issue #2284
 */

import { Request, Response, NextFunction } from "express";
import { errorHandler, AppError, createError } from "../errorHandler";
import { ERROR_CODES } from "../../constants/errorCodes";
import { PROBLEM_CONTENT_TYPE } from "../../utils/problemDetails";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<{
  headers: Record<string, string>;
  path: string;
  originalUrl: string;
  requestId: string;
}>): Request {
  const { headers = {}, originalUrl = "/test", requestId } = overrides;
  return {
    headers,
    originalUrl,
    get: (name: string) => headers[name.toLowerCase()] ?? undefined,
    requestId,
  } as unknown as Request;
}

function makeRes(): Response & {
  _status: number;
  _body: any;
  _contentType: string;
  _headers: Record<string, string>;
  status: jest.Mock;
  json: jest.Mock;
  type: jest.Mock;
} {
  const mock: any = {
    _status: 200,
    _body: null,
    _contentType: "",
    _headers: {},
    locals: {},
  };

  mock.status = jest.fn((code: number) => {
    mock._status = code;
    return mock;
  });

  mock.json = jest.fn((body: any) => {
    mock._body = body;
    return mock;
  });

  mock.type = jest.fn((ct: string) => {
    mock._contentType = ct;
    return mock;
  });

  mock.setHeader = jest.fn((name: string, value: string) => {
    mock._headers[name] = value;
  });

  return mock;
}

const next: NextFunction = jest.fn();

// ---------------------------------------------------------------------------
// RFC-7807 response when Accept: application/problem+json
// ---------------------------------------------------------------------------

describe("errorHandler — RFC-7807 Problem Details (Accept: application/problem+json)", () => {
  it("returns RFC-7807 body structure", () => {
    const req = makeReq({
      headers: { accept: PROBLEM_CONTENT_TYPE },
      originalUrl: "/api/v1/quotes",
    });
    const res = makeRes();
    const err = createError(ERROR_CODES.INVALID_INPUT, "amount is invalid");

    errorHandler(err, req, res, next);

    expect(res._status).toBe(400);
    expect(res._contentType).toBe(PROBLEM_CONTENT_TYPE);

    const body = res._body;
    expect(body).toHaveProperty("type");
    expect(body.type).toMatch(/\/invalid-input$/);
    expect(body).toHaveProperty("title", "Invalid Input");
    expect(body).toHaveProperty("status", 400);
    expect(body).toHaveProperty("detail", "amount is invalid");
    expect(body).toHaveProperty("instance", "/api/v1/quotes");
  });

  it("includes trace_id when requestId is present", () => {
    const req = makeReq({
      headers: { accept: PROBLEM_CONTENT_TYPE },
      originalUrl: "/api/v1/quotes",
      requestId: "req-abc-123",
    });
    (req as any).requestId = "req-abc-123";
    const res = makeRes();
    const err = createError(ERROR_CODES.UNAUTHORIZED, "token missing");

    errorHandler(err, req, res, next);

    expect(res._body.trace_id).toBe("req-abc-123");
  });

  it("omits trace_id when requestId is absent", () => {
    const req = makeReq({
      headers: { accept: PROBLEM_CONTENT_TYPE },
    });
    const res = makeRes();
    const err = createError(ERROR_CODES.NOT_FOUND, "resource missing");

    errorHandler(err, req, res, next);

    expect(res._body).not.toHaveProperty("trace_id");
  });

  it("maps 401 errors correctly", () => {
    const req = makeReq({ headers: { accept: PROBLEM_CONTENT_TYPE } });
    const res = makeRes();
    const err = createError(ERROR_CODES.UNAUTHORIZED, "not authenticated");

    errorHandler(err, req, res, next);

    expect(res._status).toBe(401);
    expect(res._body.title).toBe("Unauthorized");
    expect(res._body.status).toBe(401);
  });

  it("maps 404 errors correctly", () => {
    const req = makeReq({ headers: { accept: PROBLEM_CONTENT_TYPE } });
    const res = makeRes();
    const err = createError(ERROR_CODES.NOT_FOUND, "item missing");

    errorHandler(err, req, res, next);

    expect(res._status).toBe(404);
    expect(res._body.status).toBe(404);
    expect(res._body.type).toMatch(/\/not-found$/);
  });

  it("maps 500 errors correctly", () => {
    const req = makeReq({ headers: { accept: PROBLEM_CONTENT_TYPE } });
    const res = makeRes();
    const err = createError(ERROR_CODES.INTERNAL_ERROR, "unexpected failure");

    errorHandler(err, req, res, next);

    expect(res._status).toBe(500);
    expect(res._body.type).toMatch(/\/internal-error$/);
  });

  it("does NOT include 'code', 'message_en', or 'timestamp' fields (legacy fields absent)", () => {
    const req = makeReq({ headers: { accept: PROBLEM_CONTENT_TYPE } });
    const res = makeRes();
    const err = createError(ERROR_CODES.FORBIDDEN, "access denied");

    errorHandler(err, req, res, next);

    // RFC-7807 body should not carry legacy-format fields
    expect(res._body).not.toHaveProperty("message_en");
    expect(res._body).not.toHaveProperty("timestamp");
  });

  it("sets Content-Type to application/problem+json", () => {
    const req = makeReq({ headers: { accept: PROBLEM_CONTENT_TYPE } });
    const res = makeRes();
    const err = createError(ERROR_CODES.CONFLICT, "duplicate");

    errorHandler(err, req, res, next);

    expect(res._contentType).toBe(PROBLEM_CONTENT_TYPE);
  });
});

// ---------------------------------------------------------------------------
// Legacy response for clients that do NOT send Accept: application/problem+json
// ---------------------------------------------------------------------------

describe("errorHandler — legacy format (backward compatibility)", () => {
  it("returns legacy format when no Accept header is set", () => {
    const req = makeReq({});
    const res = makeRes();
    const err = createError(ERROR_CODES.INVALID_INPUT, "bad request");

    errorHandler(err, req, res, next);

    expect(res._status).toBe(400);
    // type() should NOT have been called for legacy responses
    expect(res.type).not.toHaveBeenCalled();

    const body = res._body;
    expect(body).toHaveProperty("code", ERROR_CODES.INVALID_INPUT);
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("message_en");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("statusCode", 400);
  });

  it("returns legacy format when Accept: application/json", () => {
    const req = makeReq({ headers: { accept: "application/json" } });
    const res = makeRes();
    const err = createError(ERROR_CODES.NOT_FOUND, "not found");

    errorHandler(err, req, res, next);

    expect(res._body).toHaveProperty("code", ERROR_CODES.NOT_FOUND);
    expect(res._body).not.toHaveProperty("type"); // RFC-7807 field absent
  });
});

// ---------------------------------------------------------------------------
// createError helper
// ---------------------------------------------------------------------------

describe("createError", () => {
  it("creates an AppError with the correct code and statusCode", () => {
    const err = createError(ERROR_CODES.MISSING_FIELD, "field required");
    expect(err.code).toBe(ERROR_CODES.MISSING_FIELD);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("field required");
  });

  it("attaches details when provided", () => {
    const err = createError(
      ERROR_CODES.INVALID_AMOUNT,
      "negative amount",
      { received: -10 },
    );
    expect(err.details).toEqual({ received: -10 });
  });
});
