/**
 * E2E Interactive Withdrawal Flow Suite – SEP-24
 *
 * Run: E2E_BASE_URL=http://localhost:3000 npx playwright test tests/e2e/interactive-withdrawal.spec.ts
 */
import { test, expect, APIRequestContext, request } from "@playwright/test";

const VALID_STELLAR_ACCOUNT =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const ASSET_CODE = "XLM";
const WITHDRAW_AMOUNT = "250";

test.describe("Interactive Withdrawal – SEP-24 Hosted Flow", () => {
  let api: APIRequestContext;

  test.beforeAll(async () => {
    api = await request.newContext({
      baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3000",
      extraHTTPHeaders: { "Content-Type": "application/json" },
    });
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test("GET /sep24/fee returns fee for withdrawal operation", async () => {
    const res = await api.get("/sep24/fee", {
      params: { asset_code: ASSET_CODE, amount: WITHDRAW_AMOUNT, operation: "withdrawal" },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.operation).toBe("withdrawal");
    expect(typeof body.fee).toBe("string");
  });

  let withdrawalTransactionId: string;

  test("POST /sep24/withdraw initiates interactive flow with URL + ID", async () => {
    const res = await api.post("/sep24/withdraw", {
      data: {
        asset_code: ASSET_CODE,
        amount: WITHDRAW_AMOUNT,
        account: VALID_STELLAR_ACCOUNT,
        dest: "+237670000002",
        lang: "en",
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.url).toContain("withdraw");
    expect(body.url).toContain("transaction_id=");
    expect(body.id).toBeTruthy();
    withdrawalTransactionId = body.id;
  });

  test("GET /sep24/transaction/:id shows pending withdrawal", async () => {
    test.skip(!withdrawalTransactionId, "Requires initiation");
    const res = await api.get(`/sep24/transaction/${withdrawalTransactionId}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.kind).toBe("withdrawal");
    expect(body.status).toBe("pending_user_transfer_start");
  });

  test("PUT /sep24/transaction/:id transitions to pending_stellar", async () => {
    test.skip(!withdrawalTransactionId, "Requires initiation");
    const res = await api.put(`/sep24/transaction/${withdrawalTransactionId}`, {
      data: { status: "pending_stellar", message: "Stellar tx submitted" },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).status).toBe("pending_stellar");
  });

  test("POST /sep24/callback/:id processes failure callback", async () => {
    test.skip(!withdrawalTransactionId, "Requires initiation");
    const res = await api.post(`/sep24/callback/${withdrawalTransactionId}`, {
      data: { status: "failed", message: "Insufficient funds" },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.transaction.status).toBe("failed");
    expect(body.redirect).toContain("/sep24/failure");
  });

  test("GET /sep24/failure returns failed transaction", async () => {
    test.skip(!withdrawalTransactionId, "Requires initiation");
    const res = await api.get(`/sep24/failure?id=${withdrawalTransactionId}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBeFalsy();
    expect(body.transaction.status).toBe("failed");
  });

  test("Expired callback redirects to failure", async () => {
    const initRes = await api.post("/sep24/withdraw", {
      data: { asset_code: ASSET_CODE, amount: "100", account: VALID_STELLAR_ACCOUNT },
    });
    const { id } = await initRes.json();
    const cbRes = await api.post(`/sep24/callback/${id}`, {
      data: { status: "expired", message: "Session timed out" },
    });
    expect(cbRes.ok()).toBeTruthy();
    const cb = await cbRes.json();
    expect(cb.transaction.status).toBe("expired");
    expect(cb.redirect).toContain("/sep24/failure");
  });

  test("Multiple withdrawals create distinct transactions", async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        api.post("/sep24/withdraw", {
          data: { asset_code: ASSET_CODE, amount: "50", account: VALID_STELLAR_ACCOUNT },
        }),
      ),
    );
    const ids = new Set<string>();
    for (const res of results) {
      expect(res.ok()).toBeTruthy();
      ids.add((await res.json()).id);
    }
    expect(ids.size).toBe(3);
  });

  test("POST /sep24/withdraw rejects unsupported asset", async () => {
    const res = await api.post("/sep24/withdraw", {
      data: { asset_code: "FAKECOIN", amount: "100", account: VALID_STELLAR_ACCOUNT },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /sep24/withdraw rejects invalid Stellar account", async () => {
    const res = await api.post("/sep24/withdraw", {
      data: { asset_code: ASSET_CODE, amount: WITHDRAW_AMOUNT, account: "BAD_KEY" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /sep24/callback/:id returns 404 for unknown ID", async () => {
    const res = await api.post("/sep24/callback/does-not-exist", {
      data: { status: "completed" },
    });
    expect(res.status()).toBe(404);
  });

  test("PUT /sep24/transaction/:id returns 404 for unknown ID", async () => {
    const res = await api.put("/sep24/transaction/does-not-exist", {
      data: { status: "pending_anchor" },
    });
    expect(res.status()).toBe(404);
  });

  test("GET /sep24/success returns 404 for unknown transaction", async () => {
    expect((await api.get("/sep24/success?id=unknown")).status()).toBe(404);
  });

  test("GET /sep24/failure returns 404 for unknown transaction", async () => {
    expect((await api.get("/sep24/failure?id=unknown")).status()).toBe(404);
  });
});
