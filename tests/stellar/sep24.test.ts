import request from "supertest";
import app from "../../src/index";

describe("SEP-24 Interactive Flow", () => {
  let txId: string;

  it("GET /sep24/info returns deposit and withdraw configuration", async () => {
    const res = await request(app).get("/sep24/info");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("deposit");
    expect(res.body).toHaveProperty("withdraw");
    expect(res.body.deposit).toHaveProperty("XLM");
  });

  it("POST /sep24/deposit returns interactive url and id", async () => {
    const payload = {
      asset_code: "XLM",
      amount: "10",
      account: "GBB4H2JIBOXV6JUD4F2ZXK6WOD5ALW3TBJWB3UnfF4u2PA7QQYUMVY26",
      success_url: "https://example.com/success",
      failure_url: "https://example.com/failure",
    };

    const res = await request(app).post("/sep24/deposit").send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("url");
    txId = res.body.id;
  });

  it("GET /sep24/transaction/:id returns transaction state", async () => {
    expect(txId).toBeTruthy();
    const res = await request(app).get(`/sep24/transaction/${txId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "pending_user_transfer_start");
  });

  it("POST /sep24/callback/:id completed updates status and returns redirect", async () => {
    const res = await request(app)
      .post(`/sep24/callback/${txId}`)
      .send({ status: "completed", message: "Deposit successful" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
    expect(res.body.transaction.status).toBe("completed");
    expect(res.body).toHaveProperty("redirect");
  });

  it("GET /sep24/success returns completed transaction", async () => {
    const res = await request(app).get(`/sep24/success?id=${txId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
    expect(res.body.transaction.id).toBe(txId);
  });

  it("POST /sep24/callback/:id failed updates status and return failure redirect", async () => {
    const createRes = await request(app).post("/sep24/deposit").send({
      asset_code: "XLM",
      amount: "12",
      account: "GBB4H2JIBOXV6JUD4F2ZXK6WOD5ALW3TBJWB3UnfF4u2PA7QQYUMVY26",
      success_url: "https://example.com/success",
      failure_url: "https://example.com/failure",
    });

    expect(createRes.status).toBe(200);
    const newTxId = createRes.body.id;

    const res = await request(app)
      .post(`/sep24/callback/${newTxId}`)
      .send({ status: "failed", message: "Deposit failed" });

    expect(res.status).toBe(200);
    expect(res.body.transaction.status).toBe("failed");
    expect(res.body).toHaveProperty("redirect");
  });
});
