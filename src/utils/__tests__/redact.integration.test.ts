import logger from "../logger";
/**
 * Integration smoke-tests for the redaction layer.
 *
 * These tests verify the acceptance criteria end-to-end:
 *   1. Sensitive body fields → [REDACTED] in log output
 *   2. Authorization / Cookie / X-Api-Key headers → [REDACTED]
 *   3. Error objects with sensitive content → scrubbed
 *   4. Non-sensitive data passes through unchanged
 *   5. Original objects are never mutated through the pipeline
 *
 * We drive the pipeline at the same level the logger does:
 *   buildStructuredLogEntry  →  redact  →  JSON.stringify
 * so the assertions reflect exactly what would be written to stdout/file.
 *
 * NOTE: All credential-like strings in this file are intentionally fake
 * test placeholders — they are not real secrets.
 */

import { buildStructuredLogEntry } from "../../services/structuredLogger";
import { redact, REDACTED } from "../redact";

// ---------------------------------------------------------------------------
// Helper — run the full pipeline and return the parsed log object
// ---------------------------------------------------------------------------
function pipeline(
  level: "info" | "warn" | "error",
  ...args: unknown[]
): Record<string, unknown> {
  const entry = buildStructuredLogEntry(level, args);
  const safe = redact(entry) as typeof entry;
  return JSON.parse(JSON.stringify(safe)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Sensitive request body fields
// ---------------------------------------------------------------------------

describe("smoke — sensitive body fields are redacted in log output", () => {
  it("redacts password and token from a logged request body", () => {
    const body = { username: "alice", password: "test-value-not-real", token: "test-token-not-real" };
    const log = pipeline("info", { event: "user.login", body });

    const loggedBody = (log as any).body as Record<string, unknown>;
    expect(loggedBody.username).toBe("alice");
    expect(loggedBody.password).toBe(REDACTED);
    expect(loggedBody.token).toBe(REDACTED);
  });

  it("redacts apiKey and secret from a logged payload", () => {
    const payload = { apiKey: "test-api-key-not-real", secret: "test-secret-not-real", amount: 500 };
    const log = pipeline("info", { event: "api.call", payload });

    const loggedPayload = (log as any).payload as Record<string, unknown>;
    expect(loggedPayload.apiKey).toBe(REDACTED);
    expect(loggedPayload.secret).toBe(REDACTED);
    expect(loggedPayload.amount).toBe(500);
  });

  it("redacts deeply nested sensitive fields", () => {
    const data = {
      user: {
        id: "u-1",
        loginInfo: { password: "test-value-not-real", refreshToken: "rt-test-not-real" },
      },
    };
    const log = pipeline("info", { event: "debug.dump", data });

    const loggedData = (log as any).data as any;
    expect(loggedData.user.id).toBe("u-1");
    expect(loggedData.user.loginInfo.password).toBe(REDACTED);
    expect(loggedData.user.loginInfo.refreshToken).toBe(REDACTED);
  });

  it("redacts sensitive fields inside arrays", () => {
    const items = [
      { id: 1, token: "tok-1", amount: 50 },
      { id: 2, token: "tok-2", amount: 75 },
    ];
    const log = pipeline("info", { event: "batch", items });

    const loggedItems = (log as any).items as Array<Record<string, unknown>>;
    expect(loggedItems[0].token).toBe(REDACTED);
    expect(loggedItems[0].amount).toBe(50);
    expect(loggedItems[1].token).toBe(REDACTED);
    expect(loggedItems[1].amount).toBe(75);
  });

  it("redacts a stringified-JSON body field", () => {
    const rawBody = JSON.stringify({ password: "pw-test-not-real", user: "bob" });
    const log = pipeline("info", { event: "raw.body", rawBody });

    const loggedRaw = (log as any).rawBody as string;
    const parsed = JSON.parse(loggedRaw) as Record<string, unknown>;
    expect(parsed.password).toBe(REDACTED);
    expect(parsed.user).toBe("bob");
  });
});

// ---------------------------------------------------------------------------
// 2. HTTP headers — Authorization, Cookie, X-Api-Key
// ---------------------------------------------------------------------------

describe("smoke — sensitive HTTP headers are redacted", () => {
  it("redacts Authorization header", () => {
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer test-token-not-real",
      "x-request-id": "req-001",
    };
    const log = pipeline("info", { event: "http.request", headers });

    const loggedHeaders = (log as any).headers as Record<string, unknown>;
    expect(loggedHeaders["content-type"]).toBe("application/json");
    expect(loggedHeaders["x-request-id"]).toBe("req-001");
    expect(loggedHeaders["authorization"]).toBe(REDACTED);
  });

  it("redacts Cookie header", () => {
    const headers = {
      "content-type": "application/json",
      cookie: "session=test-session; csrf=test-csrf",
    };
    const log = pipeline("info", { event: "http.request", headers });

    const loggedHeaders = (log as any).headers as Record<string, unknown>;
    expect(loggedHeaders["cookie"]).toBe(REDACTED);
    expect(loggedHeaders["content-type"]).toBe("application/json");
  });

  it("redacts X-Api-Key header (case-insensitive)", () => {
    const headersLower = { "x-api-key": "test-api-key-not-real", host: "api.example.com" };
    const headersUpper = { "X-Api-Key": "test-api-key-not-real", host: "api.example.com" };

    const logLower = pipeline("info", { event: "http.request", headers: headersLower });
    const logUpper = pipeline("info", { event: "http.request", headers: headersUpper });

    expect((logLower as any).headers["x-api-key"]).toBe(REDACTED);
    expect((logUpper as any).headers["X-Api-Key"]).toBe(REDACTED);
    expect((logLower as any).headers["host"]).toBe("api.example.com");
  });

  it("redacts all three sensitive headers simultaneously", () => {
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer test-token-not-real",
      cookie: "session=test-session",
      "x-api-key": "test-api-key-not-real",
      "x-request-id": "req-002",
    };
    const log = pipeline("info", { event: "http.request", headers });
    const loggedHeaders = (log as any).headers as Record<string, unknown>;

    expect(loggedHeaders["authorization"]).toBe(REDACTED);
    expect(loggedHeaders["cookie"]).toBe(REDACTED);
    expect(loggedHeaders["x-api-key"]).toBe(REDACTED);
    expect(loggedHeaders["content-type"]).toBe("application/json");
    expect(loggedHeaders["x-request-id"]).toBe("req-002");
  });
});

// ---------------------------------------------------------------------------
// 3. Error logging path — sensitive content in Error objects
//
// When an Error is passed as a value inside a log object (e.g. { err }),
// buildMergedEntry spreads the object and serializeUnknown serializes the
// Error via serializeError, which now preserves all enumerable own properties.
// Redaction then walks the serialized result and scrubs sensitive keys.
// ---------------------------------------------------------------------------

describe("smoke — error objects with sensitive content are scrubbed", () => {
  it("redacts a token attached to a thrown Error", () => {
    const err = new Error("Auth failed") as Error & { token?: string };
    err.token = "test-token-not-real";

    // Pass as a plain object field so buildMergedEntry spreads it into merged
    const log = pipeline("error", { event: "auth.error", err });

    // The err field is serialized by serializeUnknown → serializeError
    const loggedErr = (log as any).err as Record<string, unknown>;
    expect(loggedErr["message"]).toBe("Auth failed");
    expect(loggedErr["token"]).toBe(REDACTED);
  });

  it("redacts an apiKey attached to a thrown Error", () => {
    const err = new Error("Invalid key") as Error & { apiKey?: string };
    err.apiKey = "test-api-key-not-real";

    const log = pipeline("error", { event: "api.error", err });

    const loggedErr = (log as any).err as Record<string, unknown>;
    expect(loggedErr["apiKey"]).toBe(REDACTED);
    expect(loggedErr["message"]).toBe("Invalid key");
  });

  it("redacts a password in error details", () => {
    const err = new Error("Login failed") as Error & {
      details?: Record<string, unknown>;
    };
    err.details = { attempted_password: "test-value-not-real", username: "alice" };

    const log = pipeline("error", { event: "login.error", err });

    const loggedErr = (log as any).err as Record<string, unknown>;
    // details is an enumerable own property — preserved and walked by redact
    const details = loggedErr["details"] as Record<string, unknown>;
    // "attempted_password" contains "password" → redacted
    expect(details["attempted_password"]).toBe(REDACTED);
    expect(details["username"]).toBe("alice");
  });

  it("does not redact safe fields on an Error", () => {
    const err = new Error("Not found") as Error & { statusCode?: number };
    err.statusCode = 404;

    const log = pipeline("error", { event: "not.found", err });

    const loggedErr = (log as any).err as Record<string, unknown>;
    expect(loggedErr["message"]).toBe("Not found");
    expect(loggedErr["statusCode"]).toBe(404);
    expect(loggedErr["name"]).toBe("Error");
  });

  it("mirrors the errorHandler console.error call shape", () => {
    // errorHandler calls: logger.error({ timestamp, requestId, code, message, stack, statusCode })
    // When installGlobalLogger is active, console.error → writeEntry("error", args)
    // which calls buildStructuredLogEntry then redact.
    // We simulate that exact call shape here.
    const errPayload = {
      timestamp: new Date().toISOString(),
      requestId: "req-abc",
      code: "UNAUTHORIZED",
      message: "Token validation failed",
      stack: "Error: Token validation failed\n    at ...",
      statusCode: 401,
    };

    const log = pipeline("error", errPayload);

    // None of these field names are sensitive — they should pass through.
    expect(log["code"]).toBe("UNAUTHORIZED");
    expect(log["message"]).toBe("Token validation failed");
    expect(log["statusCode"]).toBe(401);
    expect(log["requestId"]).toBe("req-abc");
  });
});

// ---------------------------------------------------------------------------
// 4. Non-sensitive data passes through unchanged
// ---------------------------------------------------------------------------

describe("smoke — non-sensitive data is not altered", () => {
  it("passes through a safe transaction log entry", () => {
    const entry = {
      event: "transaction.completed",
      transactionId: "txn-123",
      amount: 500,
      currency: "XAF",
      status: "completed",
      userId: "u-42",
    };
    const log = pipeline("info", entry);

    expect(log["transactionId"]).toBe("txn-123");
    expect(log["amount"]).toBe(500);
    expect(log["currency"]).toBe("XAF");
    expect(log["status"]).toBe("completed");
    expect(log["userId"]).toBe("u-42");
  });

  it("passes through standard ECS envelope fields", () => {
    const log = pipeline("info", { message: "Server started", port: 3000 });

    expect(log["@timestamp"]).toBeDefined();
    expect((log as any).service?.name).toBeDefined();
    expect((log as any).log?.level).toBe("info");
    expect((log as any).ecs?.version).toBe("8.11.0");
  });
});

// ---------------------------------------------------------------------------
// 5. Original objects are never mutated through the pipeline
// ---------------------------------------------------------------------------

describe("smoke — original objects are not mutated through the pipeline", () => {
  it("does not mutate a body object passed to the logger", () => {
    const body = { password: "test-value-not-real", username: "alice" };
    const originalPassword = body.password;

    pipeline("info", { event: "login", body });

    expect(body.password).toBe(originalPassword);
  });

  it("does not mutate a headers object passed to the logger", () => {
    const headers = { authorization: "Bearer test-token-not-real", "content-type": "application/json" };
    const originalAuth = headers.authorization;

    pipeline("info", { event: "http.request", headers });

    expect(headers.authorization).toBe(originalAuth);
  });
});
