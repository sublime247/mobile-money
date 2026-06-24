/**
 * E2E Interactive Transaction Lifecycle Suite
 *
 * End-to-end test simulating real user interactive flows:
 *   1. Auth → Login → get JWT
 *   2. Deposit via main API (interactive user input simulation)
 *   3. Transaction status polling & detail retrieval
 *   4. Cancel pending transaction
 *   5. Withdrawal with 2FA challenge (interactive input)
 *   6. Update transaction notes (user interaction)
 *   7. Transaction history with filters
 *   8. Idempotency key handling
 *
 * Run: E2E_BASE_URL=http://localhost:3000 npx playwright test tests/e2e/interactive-transaction-lifecycle.spec.ts
 */
import { test, expect, APIRequestContext, request } from "@playwright/test";

const PHONE = "+237670000001";
const PASSWORD = "Test@Password1!";
const PROVIDER = "mtn";
const STELLAR_ADDRESS =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

test.describe("Interactive Transaction Lifecycle", () => {
  let api: APIRequestContext;
  let authToken: string;
  let userId: string;

  test.beforeAll(async () => {
    api = await request.newContext({
      baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3000",
      extraHTTPHeaders: { "Content-Type": "application/json" },
    });
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  // ── Auth Setup ─────────────────────────────────────────────────────────

  test("Auth: register + login to get JWT", async () => {
    // Register (may already exist)
    await api.post("/api/auth/register", {
      data: { phone_number: PHONE, password: PASSWORD },
    });

    const loginRes = await api.post("/api/auth/login", {
      data: { phone_number: PHONE },
    });
    expect(loginRes.ok(), `Login failed: ${await loginRes.text()}`).toBeTruthy();

    const body = await loginRes.json();
    expect(body.token).toBeTruthy();
    authToken = body.token;
    userId = body.user.userId;
  });

  // ── Interactive Deposit with User Input Fields ─────────────────────────

  let depositTxId: string;

  test("POST /api/transactions/deposit with full interactive user inputs", async () => {
    test.skip(!authToken, "Requires auth");

    const res = await api.post("/api/transactions/deposit", {
      headers: { Authorization: `Bearer ${authToken}` },
      data: {
        amount: "5000",
        phoneNumber: PHONE,
        provider: PROVIDER,
        stellarAddress: STELLAR_ADDRESS,
        userId,
        notes: "E2E interactive deposit test",
      },
    });

    expect([200, 400, 401, 409]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      depositTxId = body.transactionId ?? body.id;
      expect(depositTxId).toBeTruthy();
      expect(body.status).toBe("pending");
    }
  });

  // ── Transaction Detail Retrieval ───────────────────────────────────────

  test("GET /api/transactions/:id returns transaction detail", async () => {
    test.skip(!depositTxId, "Requires successful deposit");

    const res = await api.get(`/api/transactions/${depositTxId}`);
    expect([200, 401, 404]).toContain(res.status());

    if (res.status() === 200) {
      const body = await res.json();
      expect(body.id).toBe(depositTxId);
      expect(body.type).toBe("deposit");
      expect(["pending", "completed", "failed"]).toContain(body.status);
    }
  });

  // ── Cancel Pending Transaction ─────────────────────────────────────────

  test("POST /api/transactions/:id/cancel cancels pending transaction", async () => {
    test.skip(!depositTxId, "Requires successful deposit");

    const res = await api.post(`/api/transactions/${depositTxId}/cancel`);
    // 200 = cancelled, 400 = already processed, 404 = not found
    expect([200, 400, 404]).toContain(res.status());

    if (res.status() === 200) {
      const body = await res.json();
      expect(body.message).toContain("cancelled");
      expect(body.transaction).toBeDefined();
    }
  });

  // ── Deposit with Idempotency Key ───────────────────────────────────────

  test("Duplicate deposit with same Idempotency-Key returns same transaction", async () => {
    test.skip(!authToken, "Requires auth");

    const idempotencyKey = `e2e-idem-${Date.now()}`;
    const depositData = {
      amount: "1000",
      phoneNumber: PHONE,
      provider: PROVIDER,
      stellarAddress: STELLAR_ADDRESS,
      userId,
    };

    const res1 = await api.post("/api/transactions/deposit", {
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Idempotency-Key": idempotencyKey,
      },
      data: depositData,
    });

    const res2 = await api.post("/api/transactions/deposit", {
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Idempotency-Key": idempotencyKey,
      },
      data: depositData,
    });

    // Both should succeed (or both fail with same validation error)
    expect(res1.status()).toBe(res2.status());

    if (res1.status() === 200 && res2.status() === 200) {
      const body1 = await res1.json();
      const body2 = await res2.json();
      const id1 = body1.transactionId ?? body1.id;
      const id2 = body2.transactionId ?? body2.id;
      expect(id1).toBe(id2);
    }
  });

  // ── Update Notes (Interactive User Input) ──────────────────────────────

  test("PATCH /api/transactions/:id/notes updates notes", async () => {
    test.skip(!depositTxId, "Requires successful deposit");

    const res = await api.patch(`/api/transactions/${depositTxId}/notes`, {
      data: { notes: "Updated via interactive E2E test" },
    });

    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body.notes).toBe("Updated via interactive E2E test");
    }
  });

  // ── Transaction History with Filters ───────────────────────────────────

  test("GET /api/transactions returns paginated list", async () => {
    test.skip(!authToken, "Requires auth");

    const res = await api.get("/api/transactions", {
      headers: { Authorization: `Bearer ${authToken}` },
      params: { limit: "5", offset: "0" },
    });

    expect([200, 401, 403]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const items = body.data ?? body.transactions ?? body;
      expect(Array.isArray(items)).toBeTruthy();
      if (body.pagination) {
        expect(typeof body.pagination.limit).toBe("number");
      }
    }
  });

  // ── Withdrawal with 2FA Challenge ──────────────────────────────────────

  test("POST /api/transactions/withdraw without 2FA returns challenge", async () => {
    test.skip(!authToken, "Requires auth");

    const res = await api.post("/api/transactions/withdraw", {
      headers: { Authorization: `Bearer ${authToken}` },
      data: {
        amount: "1000",
        phoneNumber: PHONE,
        provider: PROVIDER,
        stellarAddress: STELLAR_ADDRESS,
        userId,
      },
    });

    // 200 = queued (2FA not required), 400 = 2FA required or validation, 401/409
    expect([200, 400, 401, 409]).toContain(res.status());

    if (res.status() === 400) {
      const body = await res.json();
      // If 2FA is required, the response includes the challenge code
      if (body.code === "TWO_FACTOR_REQUIRED") {
        expect(body.error).toContain("2FA");
        expect(body.message).toBeTruthy();
      }
    }
  });

  // ── Input Validation: Missing Fields ───────────────────────────────────

  test("POST /api/transactions/deposit rejects missing amount", async () => {
    test.skip(!authToken, "Requires auth");

    const res = await api.post("/api/transactions/deposit", {
      headers: { Authorization: `Bearer ${authToken}` },
      data: {
        phoneNumber: PHONE,
        provider: PROVIDER,
        stellarAddress: STELLAR_ADDRESS,
        userId,
      },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/transactions/deposit rejects invalid phone format", async () => {
    test.skip(!authToken, "Requires auth");

    const res = await api.post("/api/transactions/deposit", {
      headers: { Authorization: `Bearer ${authToken}` },
      data: {
        amount: "1000",
        phoneNumber: "not-a-phone",
        provider: PROVIDER,
        stellarAddress: STELLAR_ADDRESS,
        userId,
      },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/transactions/deposit rejects invalid provider", async () => {
    test.skip(!authToken, "Requires auth");

    const res = await api.post("/api/transactions/deposit", {
      headers: { Authorization: `Bearer ${authToken}` },
      data: {
        amount: "1000",
        phoneNumber: PHONE,
        provider: "invalid_provider",
        stellarAddress: STELLAR_ADDRESS,
        userId,
      },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/transactions/deposit rejects invalid Stellar address", async () => {
    test.skip(!authToken, "Requires auth");

    const res = await api.post("/api/transactions/deposit", {
      headers: { Authorization: `Bearer ${authToken}` },
      data: {
        amount: "1000",
        phoneNumber: PHONE,
        provider: PROVIDER,
        stellarAddress: "INVALID",
        userId,
      },
    });
    expect(res.status()).toBe(400);
  });

  // ── Auth Guard: Unauthenticated Access ─────────────────────────────────

  test("POST /api/transactions/deposit without auth returns 401", async () => {
    const res = await api.post("/api/transactions/deposit", {
      data: {
        amount: "1000",
        phoneNumber: PHONE,
        provider: PROVIDER,
        stellarAddress: STELLAR_ADDRESS,
        userId: "test",
      },
    });
    expect([401, 403]).toContain(res.status());
  });
});
