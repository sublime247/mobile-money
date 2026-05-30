/**
 * E2E Interactive Deposit Flow Suite
 *
 * Covers the SEP-24 interactive deposit webview lifecycle:
 *   1. SEP-24 Info & Health
 *   2. Initiate interactive deposit → receive hosted URL
 *   3. Transaction status polling
 *   4. Callback processing (simulates interactive completion)
 *   5. Success / Failure redirect endpoints
 *   6. Fee calculation endpoint
 *   7. Edge cases: invalid asset, amount bounds, bad Stellar address
 *
 * Run against a live server:
 *   E2E_BASE_URL=http://localhost:3000 npx playwright test tests/e2e/interactive-deposit.spec.ts
 */
import { test, expect, APIRequestContext, request } from "@playwright/test";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_STELLAR_ACCOUNT =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const ASSET_CODE = "XLM";
const DEPOSIT_AMOUNT = "500";
const TEST_EMAIL = "e2e-deposit@test.mobilemoney.com";
const TEST_MEMO = "e2e-deposit-test";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("Interactive Deposit – SEP-24 Hosted Flow", () => {
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

  // ── 1. SEP-24 Health ────────────────────────────────────────────────────

  test("GET /sep24/health returns ok with supported_assets", async () => {
    const res = await api.get("/sep24/health");
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(Array.isArray(body.supported_assets)).toBeTruthy();
    expect(body.supported_assets.length).toBeGreaterThan(0);
    expect(body.supported_assets).toContain("XLM");
  });

  // ── 2. SEP-24 Info ─────────────────────────────────────────────────────

  test("GET /sep24/info returns deposit and withdraw asset maps", async () => {
    const res = await api.get("/sep24/info");
    expect(res.ok()).toBeTruthy();

    const body = await res.json();

    // Deposit assets
    expect(body.deposit).toBeDefined();
    expect(body.deposit.XLM).toBeDefined();
    expect(body.deposit.XLM.deposits_enabled).toBeTruthy();

    // Withdraw assets
    expect(body.withdraw).toBeDefined();
    expect(body.withdraw.XLM).toBeDefined();
    expect(body.withdraw.XLM.withdrawals_enabled).toBeTruthy();

    // Features
    expect(body.features).toBeDefined();
    expect(typeof body.features.account_creation).toBe("boolean");
    expect(typeof body.features.claimable_balances).toBe("boolean");
  });

  // ── 3. SEP-24 Fee Calculation ──────────────────────────────────────────

  test("GET /sep24/fee returns fee for deposit operation", async () => {
    const res = await api.get("/sep24/fee", {
      params: {
        asset_code: ASSET_CODE,
        amount: DEPOSIT_AMOUNT,
        operation: "deposit",
      },
    });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.asset_code).toBe(ASSET_CODE);
    expect(body.amount).toBe(DEPOSIT_AMOUNT);
    expect(body.operation).toBe("deposit");
    expect(typeof body.fee).toBe("string");
    expect(parseFloat(body.fee)).toBeGreaterThanOrEqual(0);
  });

  test("GET /sep24/fee returns 400 for missing parameters", async () => {
    const res = await api.get("/sep24/fee", {
      params: { asset_code: ASSET_CODE },
    });
    expect(res.status()).toBe(400);
  });

  // ── 4. Initiate Interactive Deposit ────────────────────────────────────

  let depositTransactionId: string;
  let interactiveUrl: string;

  test("POST /sep24/deposit initiates interactive flow and returns URL + ID", async () => {
    const res = await api.post("/sep24/deposit", {
      data: {
        asset_code: ASSET_CODE,
        amount: DEPOSIT_AMOUNT,
        account: VALID_STELLAR_ACCOUNT,
        email: TEST_EMAIL,
        memo: TEST_MEMO,
        lang: "en",
      },
    });
    expect(res.ok(), `Deposit initiation failed: ${await res.text()}`).toBeTruthy();

    const body = await res.json();
    expect(body.url).toBeTruthy();
    expect(typeof body.url).toBe("string");
    expect(body.id).toBeTruthy();
    expect(typeof body.id).toBe("string");

    // URL should contain expected query parameters
    expect(body.url).toContain("transaction_id=");
    expect(body.url).toContain(`asset_code=${ASSET_CODE}`);
    expect(body.url).toContain(`amount=${DEPOSIT_AMOUNT}`);
    expect(body.url).toContain(`account=${VALID_STELLAR_ACCOUNT}`);
    expect(body.url).toContain("callback=");

    depositTransactionId = body.id;
    interactiveUrl = body.url;
  });

  // ── 5. Transaction Status – Pending ────────────────────────────────────

  test("GET /sep24/transaction/:id returns pending transaction after initiation", async () => {
    test.skip(!depositTransactionId, "Requires successful deposit initiation");

    const res = await api.get(`/sep24/transaction/${depositTransactionId}`);
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.id).toBe(depositTransactionId);
    expect(body.kind).toBe("deposit");
    expect(body.status).toBe("pending_user_transfer_start");
    expect(body.asset_in).toBe(ASSET_CODE);
    expect(body.amount_in).toBe(DEPOSIT_AMOUNT);
    expect(body.account).toBe(VALID_STELLAR_ACCOUNT);
    expect(body.created_at).toBeTruthy();
  });

  // ── 6. Update Transaction Status ───────────────────────────────────────

  test("PUT /sep24/transaction/:id updates status to pending_anchor", async () => {
    test.skip(!depositTransactionId, "Requires successful deposit initiation");

    const res = await api.put(`/sep24/transaction/${depositTransactionId}`, {
      data: {
        status: "pending_anchor",
        message: "Funds received, processing deposit",
      },
    });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.id).toBe(depositTransactionId);
    expect(body.status).toBe("pending_anchor");
    expect(body.message).toBe("Funds received, processing deposit");
    expect(body.updated_at).toBeTruthy();
  });

  // ── 7. Callback – Simulate Interactive Completion ──────────────────────

  test("POST /sep24/callback/:id processes completion callback", async () => {
    test.skip(!depositTransactionId, "Requires successful deposit initiation");

    const res = await api.post(`/sep24/callback/${depositTransactionId}`, {
      data: {
        status: "completed",
        message: "Deposit completed successfully",
        amount_in: DEPOSIT_AMOUNT,
        amount_out: "499.50",
        amount_fee: "0.50",
        from: "+237670000001",
        to: VALID_STELLAR_ACCOUNT,
      },
    });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.success).toBeTruthy();
    expect(body.transaction).toBeDefined();
    expect(body.transaction.status).toBe("completed");
    expect(body.transaction.completed_at).toBeTruthy();
    expect(body.transaction.amount_in).toBe(DEPOSIT_AMOUNT);
    expect(body.transaction.amount_out).toBe("499.50");
    expect(body.transaction.amount_fee).toBe("0.50");

    // Redirect URL should point to success
    expect(body.redirect).toBeDefined();
    expect(body.redirect).toContain("/sep24/success");
    expect(body.redirect).toContain(`id=${depositTransactionId}`);
  });

  // ── 8. Success Endpoint ────────────────────────────────────────────────

  test("GET /sep24/success returns completed transaction", async () => {
    test.skip(!depositTransactionId, "Requires successful deposit initiation");

    const res = await api.get(`/sep24/success?id=${depositTransactionId}`);
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.success).toBeTruthy();
    expect(body.message).toBe("Completed");
    expect(body.transaction).toBeDefined();
    expect(body.transaction.id).toBe(depositTransactionId);
    expect(body.transaction.status).toBe("completed");
  });

  // ── 9. Verify Final Transaction State ──────────────────────────────────

  test("GET /sep24/transaction/:id confirms completed state", async () => {
    test.skip(!depositTransactionId, "Requires successful deposit initiation");

    const res = await api.get(`/sep24/transaction/${depositTransactionId}`);
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.completed_at).toBeTruthy();
    expect(body.updated_at).toBeTruthy();
  });

  // ── 10. Edge Case: Invalid Asset ───────────────────────────────────────

  test("POST /sep24/deposit rejects unsupported asset", async () => {
    const res = await api.post("/sep24/deposit", {
      data: {
        asset_code: "INVALID_COIN",
        amount: "100",
        account: VALID_STELLAR_ACCOUNT,
      },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.error).toContain("not available");
  });

  // ── 11. Edge Case: Invalid Stellar Address ─────────────────────────────

  test("POST /sep24/deposit rejects invalid Stellar account", async () => {
    const res = await api.post("/sep24/deposit", {
      data: {
        asset_code: ASSET_CODE,
        amount: DEPOSIT_AMOUNT,
        account: "INVALID_ADDRESS",
      },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  // ── 12. Edge Case: Amount Below Minimum ────────────────────────────────

  test("POST /sep24/deposit rejects amount below minimum", async () => {
    const res = await api.post("/sep24/deposit", {
      data: {
        asset_code: ASSET_CODE,
        amount: "0.001",
        account: VALID_STELLAR_ACCOUNT,
      },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.error).toContain("Minimum");
  });

  // ── 13. Edge Case: Amount Above Maximum ────────────────────────────────

  test("POST /sep24/deposit rejects amount above maximum", async () => {
    const res = await api.post("/sep24/deposit", {
      data: {
        asset_code: ASSET_CODE,
        amount: "99999999999",
        account: VALID_STELLAR_ACCOUNT,
      },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.error).toContain("Maximum");
  });

  // ── 14. Edge Case: Non-existent Transaction ────────────────────────────

  test("GET /sep24/transaction/:id returns 404 for non-existent ID", async () => {
    const res = await api.get("/sep24/transaction/non-existent-id-12345");
    expect(res.status()).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  // ── 15. Interactive URL Contains Required Params ───────────────────────

  test("Interactive URL contains all expected query parameters", async () => {
    test.skip(!interactiveUrl, "Requires successful deposit initiation");

    const url = new URL(interactiveUrl);
    const params = url.searchParams;

    expect(params.get("transaction_id")).toBeTruthy();
    expect(params.get("asset_code")).toBe(ASSET_CODE);
    expect(params.get("amount")).toBe(DEPOSIT_AMOUNT);
    expect(params.get("account")).toBe(VALID_STELLAR_ACCOUNT);
    expect(params.get("lang")).toBe("en");
    expect(params.get("email")).toBe(TEST_EMAIL);
    expect(params.get("memo")).toBe(TEST_MEMO);
    expect(params.get("callback")).toBeTruthy();
  });
});
