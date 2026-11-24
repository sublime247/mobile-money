import request from "supertest";
import {
  createHorizonMockApp,
  setHorizonChaos,
  resetHorizonChaos,
  getHorizonChaos,
  setMockAccount,
  resetMockAccounts,
} from "../horizonMockServer";

describe("Mock Horizon Server – Endpoints & Chaos Controls", () => {
  const app = createHorizonMockApp();

  beforeEach(() => {
    resetHorizonChaos();
    resetMockAccounts();
  });

  describe("Standard Endpoints", () => {
    it("GET / returns Stellar Horizon root metadata", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.body.horizon_version).toBeDefined();
      expect(res.body.network_passphrase).toContain("Test SDF Network");
    });

    it("GET /health returns healthy status", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
      expect(res.body.mode).toBe("none");
    });

    it("GET /accounts/:accountId returns mock account data", async () => {
      const res = await request(app).get("/accounts/GACCOUNT123");
      expect(res.status).toBe(200);
      expect(res.body.account_id).toBe("GACCOUNT123");
      expect(res.body.sequence).toBeDefined();
      expect(Array.isArray(res.body.balances)).toBe(true);
    });

    it("GET /accounts/:accountId supports custom mock accounts", async () => {
      setMockAccount("GCUSTOMACCOUNT", {
        sequence: "999999",
        balances: [{ asset_type: "native", balance: "50.0000000" }],
      });

      const res = await request(app).get("/accounts/GCUSTOMACCOUNT");
      expect(res.status).toBe(200);
      expect(res.body.sequence).toBe("999999");
      expect(res.body.balances[0].balance).toBe("50.0000000");
    });

    it("GET /accounts/:accountId/transactions returns transaction list", async () => {
      const res = await request(app).get("/accounts/GACCOUNT123/transactions");
      expect(res.status).toBe(200);
      expect(res.body._embedded).toBeDefined();
      expect(Array.isArray(res.body._embedded.records)).toBe(true);
    });

    it("GET /fee_stats returns network fee statistics", async () => {
      const res = await request(app).get("/fee_stats");
      expect(res.status).toBe(200);
      expect(res.body.last_ledger_base_fee).toBe("100");
      expect(res.body.fee_charged).toBeDefined();
    });

    it("GET /paths/strict-receive returns payment path options", async () => {
      const res = await request(app).get("/paths/strict-receive");
      expect(res.status).toBe(200);
      expect(res.body._embedded.records.length).toBeGreaterThan(0);
    });

    it("POST /transactions submits transaction successfully", async () => {
      const res = await request(app)
        .post("/transactions")
        .send({ tx: "AAAAAMOCKTXENVELOPE" });
      expect(res.status).toBe(200);
      expect(res.body.hash).toBeDefined();
      expect(res.body.successful).toBe(true);
    });

    it("POST /transactions handles forced tx failure via header", async () => {
      const res = await request(app)
        .post("/transactions")
        .set("x-mock-tx-fail", "true")
        .send({ tx: "AAAAAMOCKTXENVELOPE" });
      expect(res.status).toBe(400);
      expect(res.body.type).toContain("transaction_failed");
      expect(res.body.extras.result_codes.transaction).toBe("tx_failed");
    });
  });

  describe("Chaos Outage Controls", () => {
    it("outageMode: '503_service_unavailable' returns HTTP 503", async () => {
      setHorizonChaos({ outageMode: "503_service_unavailable" });
      const res = await request(app).get("/accounts/GACCOUNT123");
      expect(res.status).toBe(503);
      expect(res.body.title).toBe("Service Unavailable");
    });

    it("outageMode: '500_internal_error' returns HTTP 500", async () => {
      setHorizonChaos({ outageMode: "500_internal_error" });
      const res = await request(app).get("/fee_stats");
      expect(res.status).toBe(500);
      expect(res.body.title).toBe("Internal Server Error");
    });

    it("outageMode: '429_rate_limit' returns HTTP 429 with Retry-After header", async () => {
      setHorizonChaos({ outageMode: "429_rate_limit", retryAfterSeconds: 10 });
      const res = await request(app).get("/fee_stats");
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBe("10");
      expect(res.body.title).toBe("Rate Limit Exceeded");
    });

    it("rateLimitAfter triggers 429 after specified request threshold", async () => {
      setHorizonChaos({ rateLimitAfter: 2, retryAfterSeconds: 3 });

      const res1 = await request(app).get("/");
      expect(res1.status).toBe(200);

      const res2 = await request(app).get("/");
      expect(res2.status).toBe(200);

      const res3 = await request(app).get("/");
      expect(res3.status).toBe(429);
      expect(res3.headers["retry-after"]).toBe("3");
    });

    it("delayMs delays request execution", async () => {
      setHorizonChaos({ delayMs: 100 });
      const start = Date.now();
      const res = await request(app).get("/health");
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(90);
    });

    it("resetHorizonChaos restores normal operations", async () => {
      setHorizonChaos({ outageMode: "503_service_unavailable" });
      const res1 = await request(app).get("/health");
      expect(res1.status).toBe(503);

      resetHorizonChaos();
      const res2 = await request(app).get("/health");
      expect(res2.status).toBe(200);
      expect(getHorizonChaos().outageMode).toBe("none");
    });
  });
});
