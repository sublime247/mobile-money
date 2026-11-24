import { jest } from "@jest/globals";

jest.mock("../../config/appConfig", () => ({
  getConfigValue: jest.fn((key: string) => {
    if (key === "providers.vodafoneGhana.callbackSecret")
      return "test-vf-secret";
    return undefined;
  }),
}));

const request = require("supertest");
import express, { Application } from "express";
import vodafoneGhanaCallbacksRouter from "../vodafoneGhanaCallbacks";
import { createHmac } from "crypto";
import { errorHandler } from "../../middleware/errorHandler";

function buildSignature(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

describe("Vodafone Ghana Callback Routes (#1961)", () => {
  let app: Application;

  beforeEach(() => {
    app = express();
    app.use(
      express.json({
        verify: (req: any, _res: any, buf: Buffer) => {
          req.rawBody = buf;
        },
      }),
    );
    app.use("/api/vodafone-ghana", vodafoneGhanaCallbacksRouter);
    app.use(errorHandler);
  });

  describe("POST /api/vodafone-ghana/callback", () => {
    it("accepts a valid callback with correct signature", async () => {
      const payload = { transactionId: "vf-1", status: "SUCCESSFUL" };
      const signature = buildSignature(
        JSON.stringify(payload),
        "test-vf-secret",
      );

      const response = await request(app)
        .post("/api/vodafone-ghana/callback")
        .set("x-vodafone-gh-signature", signature)
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({ status: "accepted" });
    });

    it("accepts a callback with a voucher code and optional fields", async () => {
      const payload = {
        transactionId: "vf-2",
        status: "PENDING",
        amount: 50,
        currency: "GHS",
        msisdn: "+233241234567",
        voucherCode: "VOUCH-CB-1",
      };
      const signature = buildSignature(
        JSON.stringify(payload),
        "test-vf-secret",
      );

      const response = await request(app)
        .post("/api/vodafone-ghana/callback")
        .set("x-vodafone-gh-signature", signature)
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({ status: "accepted" });
    });

    it("rejects a callback with missing signature", async () => {
      const response = await request(app)
        .post("/api/vodafone-ghana/callback")
        .send({ transactionId: "vf-1", status: "SUCCESSFUL" })
        .expect(401);

      expect(response.body.error).toBe("Unauthorized callback");
    });

    it("rejects a callback with invalid signature", async () => {
      const response = await request(app)
        .post("/api/vodafone-ghana/callback")
        .set("x-vodafone-gh-signature", "sha256=invalid")
        .send({ transactionId: "vf-1", status: "SUCCESSFUL" })
        .expect(401);

      expect(response.body.error).toBe("Unauthorized callback");
    });

    it("rejects a callback missing the required status field", async () => {
      const payload = { transactionId: "vf-1" };
      const signature = buildSignature(
        JSON.stringify(payload),
        "test-vf-secret",
      );

      const response = await request(app)
        .post("/api/vodafone-ghana/callback")
        .set("x-vodafone-gh-signature", signature)
        .send(payload)
        .expect(400);

      expect(response.body.error).toBe("Validation error");
    });
  });
});
