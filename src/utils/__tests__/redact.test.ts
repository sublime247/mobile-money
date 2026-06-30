import { redact, isSensitiveKey, REDACTED } from "../redact";

// ---------------------------------------------------------------------------
// isSensitiveKey
// ---------------------------------------------------------------------------

describe("isSensitiveKey", () => {
  it("matches exact sensitive keys", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("secret")).toBe(true);
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("pin")).toBe(true);
    expect(isSensitiveKey("otp")).toBe(true);
    expect(isSensitiveKey("mnemonic")).toBe(true);
    expect(isSensitiveKey("seed")).toBe(true);
    expect(isSensitiveKey("privateKey")).toBe(true);
    expect(isSensitiveKey("cookie")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isSensitiveKey("PASSWORD")).toBe(true);
    expect(isSensitiveKey("Token")).toBe(true);
    expect(isSensitiveKey("SECRET")).toBe(true);
    expect(isSensitiveKey("ApiKey")).toBe(true);
    expect(isSensitiveKey("Authorization")).toBe(true);
  });

  it("matches partial / compound names", () => {
    expect(isSensitiveKey("accessToken")).toBe(true);
    expect(isSensitiveKey("refreshToken")).toBe(true);
    expect(isSensitiveKey("idToken")).toBe(true);
    expect(isSensitiveKey("newPassword")).toBe(true);
    expect(isSensitiveKey("currentPassword")).toBe(true);
    expect(isSensitiveKey("x-api-key")).toBe(true);
    expect(isSensitiveKey("X-Api-Key")).toBe(true);
    expect(isSensitiveKey("clientSecret")).toBe(true);
    expect(isSensitiveKey("signingKey")).toBe(true);
    expect(isSensitiveKey("encryptionKey")).toBe(true);
    expect(isSensitiveKey("walletKey")).toBe(true);
    expect(isSensitiveKey("stellarSecret")).toBe(true);
  });

  it("does not match non-sensitive keys", () => {
    expect(isSensitiveKey("email")).toBe(false);
    expect(isSensitiveKey("username")).toBe(false);
    expect(isSensitiveKey("amount")).toBe(false);
    expect(isSensitiveKey("status")).toBe(false);
    expect(isSensitiveKey("createdAt")).toBe(false);
    expect(isSensitiveKey("userId")).toBe(false);
    expect(isSensitiveKey("transactionId")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// redact — flat objects
// ---------------------------------------------------------------------------

describe("redact — flat object with sensitive keys", () => {
  it("replaces sensitive field values with REDACTED", () => {
    const input = {
      username: "alice",
      password: "test-value-not-real",
      email: "alice@example.com",
      token: "test.jwt.token",
    };

    const result = redact(input) as typeof input;

    expect(result.username).toBe("alice");
    expect(result.email).toBe("alice@example.com");
    expect(result.password).toBe(REDACTED);
    expect(result.token).toBe(REDACTED);
  });

  it("handles all common sensitive field names", () => {
    const input = {
      apiKey: "test-api-key",
      secret: "test-secret-value",
      authorization: "Bearer test-token",
      pin: "0000",
      otp: "000000",
      mnemonic: "word1 word2 word3",
      privateKey: "TEST-PRIVATE-KEY-NOT-REAL",
      cookie: "session=test-session",
    };

    const result = redact(input) as Record<string, unknown>;

    for (const key of Object.keys(input)) {
      expect(result[key]).toBe(REDACTED);
    }
  });

  it("passes through non-sensitive fields unchanged", () => {
    const input = { amount: 100, currency: "XLM", status: "completed" };
    expect(redact(input)).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// redact — deep nesting
// ---------------------------------------------------------------------------

describe("redact — deeply nested objects", () => {
  it("redacts sensitive fields at any depth", () => {
    // Note: "credentials" itself matches the /credential/i pattern and is
    // redacted as a whole — that is correct and intentional behaviour.
    // This test uses a neutral container name to verify per-field deep walk.
    const input = {
      user: {
        id: "u-1",
        loginInfo: {
          password: "test-value-not-real",
          token: "tok-test",
        },
        profile: {
          name: "Alice",
          address: {
            city: "Douala",
          },
        },
      },
    };

    const result = redact(input) as typeof input & {
      user: { loginInfo: { password: string; token: string } };
    };

    expect((result.user as any).loginInfo.password).toBe(REDACTED);
    expect((result.user as any).loginInfo.token).toBe(REDACTED);
    expect(result.user.profile.name).toBe("Alice");
    expect(result.user.profile.address.city).toBe("Douala");
    expect(result.user.id).toBe("u-1");
  });

  it("redacts the entire value when the container key is itself sensitive (e.g. credentials)", () => {
    const input = {
      user: {
        credentials: { password: "test-value-not-real", token: "tok-test" },
      },
    };
    const result = redact(input) as { user: { credentials: unknown } };
    // The container key "credentials" matches /credential/i, so the whole
    // nested object is replaced with REDACTED rather than walked.
    expect(result.user.credentials).toBe(REDACTED);
  });

  it("handles triple-nested sensitive fields", () => {
    const input = { a: { b: { c: { apiKey: "test-api-key" } } } };
    const result = redact(input) as typeof input;
    expect(result.a.b.c.apiKey).toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// redact — arrays
// ---------------------------------------------------------------------------

describe("redact — arrays containing sensitive objects", () => {
  it("redacts sensitive fields inside array elements", () => {
    const input = [
      { id: 1, token: "tok-1", amount: 50 },
      { id: 2, token: "tok-2", amount: 75 },
    ];

    const result = redact(input) as typeof input;

    expect(result[0].token).toBe(REDACTED);
    expect(result[0].amount).toBe(50);
    expect(result[1].token).toBe(REDACTED);
    expect(result[1].amount).toBe(75);
  });

  it("handles nested arrays", () => {
    const input = {
      items: [{ password: "pw-test-1" }, { password: "pw-test-2" }],
    };
    const result = redact(input) as typeof input;
    expect(result.items[0].password).toBe(REDACTED);
    expect(result.items[1].password).toBe(REDACTED);
  });

  it("passes through arrays of non-sensitive objects unchanged", () => {
    const input = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    expect(redact(input)).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// redact — stringified JSON
// ---------------------------------------------------------------------------

describe("redact — stringified JSON as a field value", () => {
  it("parses and redacts stringified JSON objects", () => {
    const inner = JSON.stringify({ password: "pw-test", user: "alice" });
    const input = { payload: inner };

    const result = redact(input) as { payload: string };

    const parsed = JSON.parse(result.payload);
    expect(parsed.password).toBe(REDACTED);
    expect(parsed.user).toBe("alice");
  });

  it("parses and redacts stringified JSON arrays", () => {
    const inner = JSON.stringify([{ token: "tok-1" }, { token: "tok-2" }]);
    const input = { data: inner };

    const result = redact(input) as { data: string };

    const parsed = JSON.parse(result.data) as Array<{ token: string }>;
    expect(parsed[0].token).toBe(REDACTED);
    expect(parsed[1].token).toBe(REDACTED);
  });

  it("leaves non-JSON strings untouched", () => {
    const input = { message: "hello world", status: "ok" };
    expect(redact(input)).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// redact — Error objects
// ---------------------------------------------------------------------------

describe("redact — Error objects", () => {
  it("serializes an Error and redacts sensitive fields attached to it", () => {
    const err = new Error("Something went wrong") as Error & {
      token?: string;
      statusCode?: number;
    };
    err.token = "test-token-not-real";
    err.statusCode = 500;

    const result = redact(err) as Record<string, unknown>;

    expect(result["message"]).toBe("Something went wrong");
    expect(result["token"]).toBe(REDACTED);
    expect(result["statusCode"]).toBe(500);
    expect(result["name"]).toBe("Error");
  });

  it("does not expose the original Error object", () => {
    const err = new Error("test");
    const result = redact(err);
    expect(result).not.toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// redact — immutability
// ---------------------------------------------------------------------------

describe("redact — original objects are never mutated", () => {
  it("does not mutate a flat object", () => {
    const input = { password: "test-value-not-real", name: "Alice" };
    const copy = { ...input };
    redact(input);
    expect(input).toEqual(copy);
  });

  it("does not mutate a nested object", () => {
    const input = { user: { token: "tok-test", id: "1" } };
    const originalToken = input.user.token;
    redact(input);
    expect(input.user.token).toBe(originalToken);
  });

  it("does not mutate array elements", () => {
    const input = [{ apiKey: "key-test-1" }, { apiKey: "key-test-2" }];
    const originals = input.map((i) => i.apiKey);
    redact(input);
    input.forEach((item, idx) => {
      expect(item.apiKey).toBe(originals[idx]);
    });
  });
});

// ---------------------------------------------------------------------------
// redact — non-sensitive pass-through
// ---------------------------------------------------------------------------

describe("redact — non-sensitive objects pass through unchanged", () => {
  it("returns primitives as-is", () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact("hello")).toBe("hello");
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it("returns a structurally equal clone for safe objects", () => {
    const input = {
      id: "txn-123",
      amount: 500,
      currency: "XAF",
      status: "completed",
      createdAt: "2026-04-25T10:00:00Z",
    };
    expect(redact(input)).toEqual(input);
  });

  it("does not alter the message field of a safe Error", () => {
    const err = new Error("Not found");
    const result = redact(err) as Record<string, unknown>;
    expect(result["message"]).toBe("Not found");
  });
});

// ---------------------------------------------------------------------------
// redact — HTTP-specific headers
// ---------------------------------------------------------------------------

describe("redact — HTTP headers", () => {
  it("redacts Authorization, Cookie, and X-Api-Key headers", () => {
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer test-token-not-real",
      cookie: "session=test-session; csrf=test-csrf",
      "x-api-key": "test-api-key-not-real",
      "x-request-id": "req-001",
    };

    const result = redact(headers) as typeof headers;

    expect(result["content-type"]).toBe("application/json");
    expect(result["x-request-id"]).toBe("req-001");
    expect(result["authorization"]).toBe(REDACTED);
    expect(result["cookie"]).toBe(REDACTED);
    expect(result["x-api-key"]).toBe(REDACTED);
  });
});
