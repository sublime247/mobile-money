import test from "node:test";
import assert from "node:assert/strict";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("FetchTransport retries idempotent GET requests on transient network errors", async () => {
  const { FetchTransport } = await import("../ts/transport.ts");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) throw new TypeError("network drop");
    return jsonResponse(200, { ok: true });
  };

  try {
    const transport = new FetchTransport({ baseDelayMs: 1, maxDelayMs: 2 });
    const res = await transport.request({ method: "GET", url: "https://example.com/x" });
    assert.strictEqual(calls, 3, "should have retried twice before succeeding");
    assert.deepStrictEqual(res.data, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FetchTransport retries on HTTP 429 and 503 for idempotent requests", async () => {
  const { FetchTransport } = await import("../ts/transport.ts");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return jsonResponse(429, { error: "rate limited" });
    if (calls === 2) return jsonResponse(503, { error: "unavailable" });
    return jsonResponse(200, { ok: true });
  };

  try {
    const transport = new FetchTransport({ baseDelayMs: 1, maxDelayMs: 2 });
    const res = await transport.request({ method: "PUT", url: "https://example.com/x" });
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(res.data, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FetchTransport gives up after maxRetries and surfaces the last error", async () => {
  const { FetchTransport } = await import("../ts/transport.ts");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError("network drop");
  };

  try {
    const transport = new FetchTransport({ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 });
    await assert.rejects(
      () => transport.request({ method: "DELETE", url: "https://example.com/x" }),
      /network drop|Network request failed/,
    );
    assert.strictEqual(calls, 3, "initial attempt + 2 retries");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FetchTransport does not retry non-idempotent POST without Idempotency-Key", async () => {
  const { FetchTransport } = await import("../ts/transport.ts");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError("network drop");
  };

  try {
    const transport = new FetchTransport({ baseDelayMs: 1, maxDelayMs: 2 });
    await assert.rejects(() =>
      transport.request({ method: "POST", url: "https://example.com/x" }),
    );
    assert.strictEqual(calls, 1, "plain POST must not be retried");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FetchTransport retries POST requests that carry an Idempotency-Key header", async () => {
  const { FetchTransport } = await import("../ts/transport.ts");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 2) throw new TypeError("network drop");
    return jsonResponse(200, { ok: true });
  };

  try {
    const transport = new FetchTransport({ baseDelayMs: 1, maxDelayMs: 2 });
    const res = await transport.request({
      method: "POST",
      url: "https://example.com/x",
      headers: { "Idempotency-Key": "abc-123" },
    });
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(res.data, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FetchTransport does not retry non-retryable 4xx errors like 400 or 404", async () => {
  const { FetchTransport } = await import("../ts/transport.ts");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse(404, { error: "not found" });
  };

  try {
    const transport = new FetchTransport({ baseDelayMs: 1, maxDelayMs: 2 });
    await assert.rejects(() =>
      transport.request({ method: "GET", url: "https://example.com/x" }),
    );
    assert.strictEqual(calls, 1, "non-retryable status must not be retried");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FetchTransport honors retry.enabled = false", async () => {
  const { FetchTransport } = await import("../ts/transport.ts");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError("network drop");
  };

  try {
    const transport = new FetchTransport({ enabled: false });
    await assert.rejects(() =>
      transport.request({ method: "GET", url: "https://example.com/x" }),
    );
    assert.strictEqual(calls, 1, "retries must be disabled entirely");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
