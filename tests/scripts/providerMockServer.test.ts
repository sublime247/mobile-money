import { createProviderMockApp } from "../../scripts/provider-mock-server";
import request = require("supertest");

describe("provider mock server", () => {
  const app = createProviderMockApp();

  it("serves health information", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      providers: [
        "mtn",
        "airtel",
        "vodacom",
        "tigo",
        "moov",
        "orange",
        "mpesa",
      ],
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

  describe("Orange Mock Endpoints (#1965)", () => {
    it("returns mock access token", async () => {
      const response = await request(app).post("/orange/oauth/token");
      expect(response.status).toBe(200);
      expect(response.body.access_token).toBe("mock-orange-access-token");
    });

    it("stores Orange success collections and returns the matching status", async () => {
      const createResponse = await request(app)
        .post("/orange/v1/payments/collect?scenario=success")
        .send({ reference: "orange-ref-1" });

      expect(createResponse.status).toBe(202);
      expect(createResponse.body.status).toBe("SUCCESSFUL");

      const statusResponse = await request(app).get(
        "/orange/v1/payments/orange-ref-1",
      );
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.status).toBe("SUCCESSFUL");
    });

    it("returns Orange disbursement failures when requested", async () => {
      const response = await request(app)
        .post("/orange/v1/payments/disburse?scenario=failed")
        .send({ reference: "orange-payout-1" });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("FAILED");
    });

    it("returns Orange pending status", async () => {
      const response = await request(app)
        .post("/orange/v1/payments/collect?scenario=pending")
        .send({ reference: "orange-pending-1" });

      expect(response.status).toBe(202);
      expect(response.body.status).toBe("PENDING");
    });
  });

  describe("M-Pesa Mock Endpoints (#1965)", () => {
    it("returns mock access token", async () => {
      const response = await request(app).get("/mpesa/oauth/v1/generate");
      expect(response.status).toBe(200);
      expect(response.body.access_token).toBe("mock-mpesa-access-token");
    });

    it("accepts an STK push and reports success on query", async () => {
      const stkResponse = await request(app)
        .post("/mpesa/mpesa/stkpush/v1/processrequest?scenario=success")
        .send({ referenceId: "mpesa-stk-1" });

      expect(stkResponse.status).toBe(200);
      expect(stkResponse.body.ResponseCode).toBe("0");
      expect(stkResponse.body.CheckoutRequestID).toBe("mpesa-stk-1");

      const queryResponse = await request(app)
        .post("/mpesa/mpesa/stkpushquery/v1/query")
        .send({ referenceId: "mpesa-stk-1" });

      expect(queryResponse.status).toBe(200);
      expect(queryResponse.body.ResultCode).toBe("0");
    });

    it("reports a failed B2C disbursement", async () => {
      const response = await request(app)
        .post("/mpesa/mpesa/b2c/v1/paymentrequest?scenario=failed")
        .send({ referenceId: "mpesa-b2c-1" });

      expect(response.status).toBe(400);
      expect(response.body.ResponseCode).toBe("1");
    });

    it("reports a pending STK query as ResultCode NaN", async () => {
      await request(app)
        .post("/mpesa/mpesa/stkpush/v1/processrequest?scenario=pending")
        .send({ referenceId: "mpesa-stk-pending" });

      const response = await request(app)
        .post("/mpesa/mpesa/stkpushquery/v1/query")
        .send({ referenceId: "mpesa-stk-pending" });

      expect(response.status).toBe(200);
      expect(response.body.ResultCode).toBe("NaN");
    });
  });

  describe("timeout scenario (#1965)", () => {
    it("never resolves an MTN request-to-pay when scenario=timeout", async () => {
      const requestPromise = request(app)
        .post("/mtn/collection/v1_0/requesttopay?scenario=timeout")
        .send({ externalId: "mtn-timeout-1" })
        .timeout({ response: 200, deadline: 500 });

      await expect(requestPromise).rejects.toThrow();
    });
  });
});
