import test from "node:test";
import assert from "node:assert/strict";
import {
  MobileMoneyError,
  BridgeError,
  AuthenticationError,
  InsufficientFundsError,
  TelcoTimeoutError,
  RateLimitError,
  ValidationError,
  NotFoundError,
  parseApiError,
} from "../ts/errors.ts";
import { apiResponseInterceptor } from "../src/client.ts";
import { FetchTransport } from "../ts/transport.ts";

test("Error class hierarchy extends MobileMoneyError", () => {
  const base = new MobileMoneyError("Base error");
  assert.ok(base instanceof Error);
  assert.ok(base instanceof MobileMoneyError);
  assert.strictEqual(base.name, "MobileMoneyError");

  const auth = new AuthenticationError("Unauthorized");
  assert.ok(auth instanceof Error);
  assert.ok(auth instanceof MobileMoneyError);
  assert.ok(auth instanceof AuthenticationError);
  assert.strictEqual(auth.name, "AuthenticationError");
  assert.strictEqual(auth.statusCode, 401);
  assert.strictEqual(auth.status, 401);
  assert.strictEqual(auth.providerErrorCode, "AUTHENTICATION_FAILED");
  assert.strictEqual(auth.code, "AUTHENTICATION_FAILED");

  const funds = new InsufficientFundsError("Not enough balance");
  assert.ok(funds instanceof Error);
  assert.ok(funds instanceof MobileMoneyError);
  assert.ok(funds instanceof InsufficientFundsError);
  assert.strictEqual(funds.name, "InsufficientFundsError");
  assert.strictEqual(funds.statusCode, 400);
  assert.strictEqual(funds.providerErrorCode, "INSUFFICIENT_FUNDS");

  const timeout = new TelcoTimeoutError("Provider did not respond");
  assert.ok(timeout instanceof Error);
  assert.ok(timeout instanceof MobileMoneyError);
  assert.ok(timeout instanceof TelcoTimeoutError);
  assert.strictEqual(timeout.name, "TelcoTimeoutError");
  assert.strictEqual(timeout.statusCode, 504);
  assert.strictEqual(timeout.providerErrorCode, "TELCO_TIMEOUT");

  const rate = new RateLimitError("Too many requests");
  assert.ok(rate instanceof Error);
  assert.ok(rate instanceof MobileMoneyError);
  assert.ok(rate instanceof RateLimitError);
  assert.strictEqual(rate.name, "RateLimitError");
  assert.strictEqual(rate.statusCode, 429);
  assert.strictEqual(rate.providerErrorCode, "RATE_LIMIT_EXCEEDED");

  const validation = new ValidationError("Invalid parameter");
  assert.ok(validation instanceof Error);
  assert.ok(validation instanceof MobileMoneyError);
  assert.ok(validation instanceof ValidationError);
  assert.strictEqual(validation.name, "ValidationError");
  assert.strictEqual(validation.statusCode, 400);
  assert.strictEqual(validation.providerErrorCode, "VALIDATION_ERROR");

  const notFound = new NotFoundError("Resource not found");
  assert.ok(notFound instanceof Error);
  assert.ok(notFound instanceof MobileMoneyError);
  assert.ok(notFound instanceof NotFoundError);
  assert.strictEqual(notFound.name, "NotFoundError");
  assert.strictEqual(notFound.statusCode, 404);
  assert.strictEqual(notFound.providerErrorCode, "NOT_FOUND");

  const bridge = new BridgeError("Legacy bridge error", 500, "CUSTOM_ERR");
  assert.ok(bridge instanceof Error);
  assert.ok(bridge instanceof MobileMoneyError);
  assert.ok(bridge instanceof BridgeError);
  assert.strictEqual(bridge.statusCode, 500);
  assert.strictEqual(bridge.providerErrorCode, "CUSTOM_ERR");
});

test("Error instances preserve providerErrorCode, requestId, and statusCode", () => {
  const err = new AuthenticationError("Invalid API key", {
    statusCode: 401,
    providerErrorCode: "INVALID_KEY",
    requestId: "req-xyz-987",
    details: { reason: "expired" },
  });

  assert.strictEqual(err.message, "Invalid API key");
  assert.strictEqual(err.statusCode, 401);
  assert.strictEqual(err.status, 401);
  assert.strictEqual(err.providerErrorCode, "INVALID_KEY");
  assert.strictEqual(err.code, "INVALID_KEY");
  assert.strictEqual(err.requestId, "req-xyz-987");
  assert.deepStrictEqual(err.details, { reason: "expired" });
});

test("parseApiError correctly maps HTTP response payloads and headers to typed error classes", () => {
  // 1. 401 AuthenticationError
  const err401 = parseApiError(
    401,
    { message: "Invalid bearer token", code: "TOKEN_EXPIRED" },
    { "x-request-id": "req-1" }
  );
  assert.ok(err401 instanceof AuthenticationError);
  assert.strictEqual(err401.statusCode, 401);
  assert.strictEqual(err401.providerErrorCode, "TOKEN_EXPIRED");
  assert.strictEqual(err401.requestId, "req-1");
  assert.strictEqual(err401.message, "Invalid bearer token");

  // 2. 429 RateLimitError
  const err429 = parseApiError(
    429,
    { error: "Rate limit exceeded. Try again in 30s.", code: "RATE_LIMIT_EXCEEDED" },
    { "X-Request-Id": "req-2" }
  );
  assert.ok(err429 instanceof RateLimitError);
  assert.strictEqual(err429.statusCode, 429);
  assert.strictEqual(err429.providerErrorCode, "RATE_LIMIT_EXCEEDED");
  assert.strictEqual(err429.requestId, "req-2");

  // 3. 504 TelcoTimeoutError
  const err504 = parseApiError(
    504,
    { error: "Telco gateway timed out", provider_error_code: "TELCO_TIMEOUT", request_id: "req-3" },
    {}
  );
  assert.ok(err504 instanceof TelcoTimeoutError);
  assert.strictEqual(err504.statusCode, 504);
  assert.strictEqual(err504.providerErrorCode, "TELCO_TIMEOUT");
  assert.strictEqual(err504.requestId, "req-3");

  // 4. InsufficientFundsError from 400 with INSUFFICIENT_FUNDS
  const errFunds = parseApiError(
    400,
    { message: "Balance is too low for transfer", code: "INSUFFICIENT_FUNDS" },
    { "x-request-id": "req-4" }
  );
  assert.ok(errFunds instanceof InsufficientFundsError);
  assert.strictEqual(errFunds.statusCode, 400);
  assert.strictEqual(errFunds.providerErrorCode, "INSUFFICIENT_FUNDS");
  assert.strictEqual(errFunds.requestId, "req-4");

  // 5. 404 NotFoundError
  const err404 = parseApiError(404, { message: "Account not found" }, { "x-request-id": "req-5" });
  assert.ok(err404 instanceof NotFoundError);
  assert.strictEqual(err404.statusCode, 404);
  assert.strictEqual(err404.requestId, "req-5");

  // 6. 400 ValidationError
  const err400 = parseApiError(400, { error: "Missing required field: amount" }, { "x-request-id": "req-6" });
  assert.ok(err400 instanceof ValidationError);
  assert.strictEqual(err400.statusCode, 400);
  assert.strictEqual(err400.requestId, "req-6");

  // 7. Generic 500 MobileMoneyError
  const err500 = parseApiError(500, { error: "Internal server error" }, { "x-request-id": "req-7" });
  assert.ok(err500 instanceof MobileMoneyError);
  assert.strictEqual(err500.statusCode, 500);
  assert.strictEqual(err500.requestId, "req-7");
});

test("apiResponseInterceptor validates response and throws typed error on error status", () => {
  // Successful response passes through
  const success = apiResponseInterceptor({ status: 200, data: { ok: true } });
  assert.strictEqual(success.status, 200);

  // 401 throws AuthenticationError
  assert.throws(
    () =>
      apiResponseInterceptor({
        status: 401,
        data: { error: "Unauthorized" },
        headers: { "x-request-id": "req-auth" },
      }),
    (err: any) =>
      err instanceof AuthenticationError &&
      err.statusCode === 401 &&
      err.requestId === "req-auth"
  );

  // 429 throws RateLimitError
  assert.throws(
    () =>
      apiResponseInterceptor({
        status: 429,
        data: { error: "Too many calls" },
      }),
    (err: any) => err instanceof RateLimitError && err.statusCode === 429
  );
});

test("FetchTransport parses error responses and throws typed MobileMoneyError instances", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Mock fetch returning 504 Gateway Timeout with telco error payload
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "Orange Money telco network timeout",
          code: "TELCO_TIMEOUT",
          request_id: "req-fetch-504",
        }),
        {
          status: 504,
          statusText: "Gateway Timeout",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "req-fetch-504",
          },
        }
      );

    const transport = new FetchTransport({ enabled: false });

    await assert.rejects(
      async () => {
        await transport.request({ method: "POST", url: "https://api.bridge.stellarwave.io/test" });
      },
      (err: any) => {
        assert.ok(err instanceof TelcoTimeoutError);
        assert.ok(err instanceof MobileMoneyError);
        assert.strictEqual(err.statusCode, 504);
        assert.strictEqual(err.providerErrorCode, "TELCO_TIMEOUT");
        assert.strictEqual(err.requestId, "req-fetch-504");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

