import { createProviderMockApp } from "../../scripts/provider-mock-server";
import mockServerConfig from "../../src/config/mockServer";
import request from "supertest";

mockServerConfig.webhookLatencyEnabled = false;

describe("provider mock server", () => {
  const app = createProviderMockApp();

  it("serves health information", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      providers: ["mtn", "airtel", "tigo", "vodacom"],
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

  it("supports Tigo collection, status, payout, and balance mock routes", async () => {
    const collectionResponse = await request(app)
      .post("/tigo/payments/collect?scenario=pending")
      .send({ externalId: "tigo-ref-123" });

    expect(collectionResponse.status).toBe(202);
    expect(collectionResponse.body).toMatchObject({
      referenceId: "tigo-ref-123",
      status: "PENDING",
    });

    const statusResponse = await request(app).get(
      "/tigo/payments/status/tigo-ref-123",
    );

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toMatchObject({
      referenceId: "tigo-ref-123",
      status: "PENDING",
    });

    const payoutResponse = await request(app)
      .post("/tigo/payments/disburse")
      .send({ reference: "tigo-payout-123" });

    expect(payoutResponse.status).toBe(202);
    expect(payoutResponse.body).toMatchObject({
      referenceId: "tigo-payout-123",
      status: "SUCCESSFUL",
    });

    const balanceResponse = await request(app).get("/tigo/account/balance");

    expect(balanceResponse.status).toBe(200);
    expect(balanceResponse.body).toMatchObject({
      availableBalance: "100000",
      currency: "TZS",
    });
  });

  it("supports Vodacom session, c2b, b2c, and status mock routes", async () => {
    const sessionResponse = await request(app).get(
      "/vodacom/vodacomTZN/getSession/",
    );

    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.body).toMatchObject({
      output_ResponseCode: "INS-0",
      output_SessionID: "mock-vodacomTZN-session-token",
    });

    const c2bResponse = await request(app)
      .post("/vodacom/vodacomTZN/c2bPayment/singleStage/?scenario=pending")
      .send({ reference: "vodacom-c2b-123" });

    expect(c2bResponse.status).toBe(200);
    expect(c2bResponse.body).toMatchObject({
      output_ResponseCode: "INS-0",
      output_TransactionID: "vodacom-c2b-123",
      output_TransactionStatus: "PENDING",
    });

    const statusResponse = await request(app)
      .get("/vodacom/vodacomTZN/queryTransactionStatus/")
      .query({ input_QueryReference: "vodacom-c2b-123" });

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toMatchObject({
      output_TransactionID: "vodacom-c2b-123",
      output_TransactionStatus: "PENDING",
    });

    const b2cResponse = await request(app)
      .post("/vodacom/vodacomTZN/b2cPayment/singleStage/")
      .send({ reference: "vodacom-b2c-123" });

    expect(b2cResponse.status).toBe(200);
    expect(b2cResponse.body).toMatchObject({
      output_ResponseCode: "INS-0",
      output_TransactionID: "vodacom-b2c-123",
      output_TransactionStatus: "COMPLETED",
    });
  });
});
