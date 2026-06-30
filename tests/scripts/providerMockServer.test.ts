import { createProviderMockApp } from "../../scripts/provider-mock-server";
import request = require("supertest");

describe("provider mock server", () => {
  const app = createProviderMockApp();

  it("serves health information", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      providers: ["mtn", "airtel", "vodacom", "tigo"],
    });
  });

  it("stores MTN pending transactions and returns the matching status", async () => {
    const createResponse = await request(app)
      .post("/mtn/collection/v1_0/requesttopay?scenario=pending")
      .send({
        externalId: "mtn-ref-123",
      });

    expect(createResponse.status).toBe(202);
    expect(createResponse.body.status).toBe("PENDING");

    const statusResponse = await request(app).get(
      "/mtn/collection/v1_0/requesttopay/mtn-ref-123",
    );

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toMatchObject({
      referenceId: "mtn-ref-123",
      status: "PENDING",
    });
  });

  it("returns Airtel success status codes for stored transactions", async () => {
    const createResponse = await request(app)
      .post("/airtel/merchant/v1/payments/")
      .send({
        reference: "airtel-ref-123",
        scenario: "success",
      });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.data.transaction.status).toBe("TS");

    const statusResponse = await request(app).get(
      "/airtel/standard/v1/payments/airtel-ref-123",
    );

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.data.transaction.status).toBe("TS");
  });

  it("supports custom per-request delays", async () => {
    const startedAt = Date.now();

    const response = await request(app)
      .get("/mtn/disbursement/v1_0/account/balance")
      .set("x-mock-delay-ms", "60");

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it("returns provider failures when requested", async () => {
    const response = await request(app).get(
      "/airtel/standard/v1/users/balance?scenario=failed",
    );

    expect(response.status).toBe(503);
    expect(response.body.status).toEqual({
      success: false,
      code: "BALANCE_UNAVAILABLE",
    });
  });

  describe("Vodacom Mock Endpoints", () => {
    it("returns mock access token", async () => {
      const response = await request(app).post("/vodacom/auth/token");
      expect(response.status).toBe(200);
      expect(response.body.access_token).toBe("mock-vodacom-access-token");
    });

    it("stores Vodacom pending payment and returns PENDING status", async () => {
      const createResponse = await request(app)
        .post("/vodacom/c2b/v1/payment?scenario=pending")
        .send({ externalId: "voda-pay-1" });
      expect(createResponse.status).toBe(202);
      expect(createResponse.body.status).toBe("PENDING");

      const statusResponse = await request(app).get(
        "/vodacom/c2b/v1/payment/voda-pay-1",
      );
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.status).toBe("PENDING");
    });

    it("handles Vodacom failed disbursements", async () => {
      const response = await request(app)
        .post("/vodacom/b2c/v1/payment?scenario=failed")
        .send({ externalId: "voda-b2c-2" });
      expect(response.status).toBe(400);
      expect(response.body.status).toBe("FAILED");
    });

    it("returns Vodacom balance", async () => {
      const response = await request(app).get("/vodacom/balance");
      expect(response.status).toBe(200);
      expect(response.body.availableBalance).toBeDefined();
      expect(response.body.currency).toBe("TZS");
    });
  });

  describe("Tigo Mock Endpoints", () => {
    it("returns mock access token", async () => {
      const response = await request(app).post("/tigo/auth/token");
      expect(response.status).toBe(200);
      expect(response.body.access_token).toBe("mock-tigo-access-token");
    });

    it("stores Tigo success payments", async () => {
      const createResponse = await request(app)
        .post("/tigo/payment?scenario=success")
        .send({ reference: "tigo-pay-1" });
      expect(createResponse.status).toBe(200);
      expect(createResponse.body.status).toBe("SUCCESS");

      const statusResponse = await request(app).get("/tigo/payment/tigo-pay-1");
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.status).toBe("SUCCESS");
    });

    it("returns Tigo balance", async () => {
      const response = await request(app).get("/tigo/balance");
      expect(response.status).toBe(200);
      expect(response.body.availableBalance).toBeDefined();
      expect(response.body.currency).toBe("TZS");
    });
  });
});
