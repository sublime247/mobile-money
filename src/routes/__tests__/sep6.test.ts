import express from "express";
import request from "supertest";
import { createSep6Router } from "../../stellar/sep6";

describe("SEP-6 Routes Integration (#2268)", () => {
  let app: express.Express;
  const mockDb: any = {
    query: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STELLAR_TRANSFER_SERVER;
    app = express();
    app.use(express.json());
    app.use("/sep6", createSep6Router(mockDb));
  });

  it("GET /sep6/info returns valid compliant schema response", async () => {
    const res = await request(app).get("/sep6/info");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("deposit");
    expect(res.body).toHaveProperty("withdraw");
    expect(res.body).toHaveProperty("fee");
    expect(res.body.fee.enabled).toBe(true);

    const xlmDeposit = res.body.deposit.XLM;
    expect(xlmDeposit).toBeDefined();
    expect(xlmDeposit.enabled).toBe(true);
    expect(xlmDeposit.min_amount).toBeDefined();
    expect(xlmDeposit.max_amount).toBeDefined();
    expect(xlmDeposit.fee_fixed).toBeDefined();
    expect(xlmDeposit.fee_percent).toBeDefined();
    expect(xlmDeposit.max_amount).toBeGreaterThanOrEqual(xlmDeposit.min_amount);
  });
});
