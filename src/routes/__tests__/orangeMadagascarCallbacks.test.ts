import { jest } from "@jest/globals";

jest.mock("../../config/appConfig", () => ({
  getConfigValue: jest.fn((key: string) => {
    if (key === "providers.orangeMadagascar.callbackSecret") return "test-oma-secret";
    if (key === "providers.orangeMadagascar.callbackSignatureHeader") return "x-callback-signature";
    return undefined;
  }),
}));

const request = require("supertest");
import express, { Application } from "express";
import orangeMadagascarCallbacksRouter from "../orangeMadagascarCallbacks";
import { createHmac } from "crypto";
import { errorHandler } from "../../middleware/errorHandler";

function buildSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64");
}

describe("Orange Madagascar Callback Routes", () => {
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
    app.use("/api/orange-madagascar", orangeMadagascarCallbacksRouter);
    app.use(errorHandler);
  });

  describe("POST /api/orange-madagascar/callback", () => {
    it("accepts a valid callback with correct signature", async () => {
      const payload = { reference: "ref-1", status: "SUCCESSFUL" };
      const payloadStr = JSON.stringify(payload);
      const signature = buildSignature(payloadStr, "test-oma-secret");

      const response = await request(app)
        .post("/api/orange-madagascar/callback")
        .set("X-Callback-Signature", signature)
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({ status: "accepted" });
    });

    it("accepts a callback with optional fields", async () => {
      const payload = {
        reference: "ref-2",
        status: "SUCCESSFUL",
        transactionId: "txn-001",
        amount: 5000,
        currency: "MGA",
        msisdn: "+261340000000",
      };
      const payloadStr = JSON.stringify(payload);
      const signature = buildSignature(payloadStr, "test-oma-secret");

      const response = await request(app)
        .post("/api/orange-madagascar/callback")
        .set("X-Callback-Signature", signature)
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({ status: "accepted" });
    });

    it("rejects a callback with missing signature", async () => {
      const response = await request(app)
        .post("/api/orange-madagascar/callback")
        .send({ reference: "ref-1", status: "SUCCESSFUL" })
        .expect(401);

      expect(response.body.error).toBe("Unauthorized callback");
    });

    it("rejects a callback with invalid signature", async () => {
      const response = await request(app)
        .post("/api/orange-madagascar/callback")
        .set("X-Callback-Signature", "invalid-sig")
        .send({ reference: "ref-1", status: "SUCCESSFUL" })
        .expect(401);

      expect(response.body.error).toBe("Unauthorized callback");
    });

    it("rejects a callback with invalid status value", async () => {
      const payload = { reference: "ref-1", status: "INVALID_STATUS" };
      const payloadStr = JSON.stringify(payload);
      const signature = buildSignature(payloadStr, "test-oma-secret");

      const response = await request(app)
        .post("/api/orange-madagascar/callback")
        .set("X-Callback-Signature", signature)
        .send(payload)
        .expect(400);

      expect(response.body.error).toBe("Validation error");
    });

    it("rejects a callback missing required reference field", async () => {
      const payload = { status: "SUCCESSFUL" };
      const payloadStr = JSON.stringify(payload);
      const signature = buildSignature(payloadStr, "test-oma-secret");

      const response = await request(app)
        .post("/api/orange-madagascar/callback")
        .set("X-Callback-Signature", signature)
        .send(payload)
        .expect(400);

      expect(response.body.error).toBe("Validation error");
    });
  });

  describe("POST /api/orange-madagascar/callback/batch", () => {
    it("accepts a valid batch callback", async () => {
      const payload = {
        batchId: "batch-1",
        items: [
          { referenceId: "tx1", status: "SUCCESSFUL", transactionId: "pmt-1" },
          { referenceId: "tx2", status: "FAILED", errorReason: "timeout" },
        ],
      };
      const payloadStr = JSON.stringify(payload);
      const signature = buildSignature(payloadStr, "test-oma-secret");

      const response = await request(app)
        .post("/api/orange-madagascar/callback/batch")
        .set("X-Callback-Signature", signature)
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({ status: "accepted" });
    });

    it("rejects batch callback missing batchId", async () => {
      const payload = { items: [] };
      const payloadStr = JSON.stringify(payload);
      const signature = buildSignature(payloadStr, "test-oma-secret");

      const response = await request(app)
        .post("/api/orange-madagascar/callback/batch")
        .set("X-Callback-Signature", signature)
        .send(payload)
        .expect(400);

      expect(response.body.error).toBe("Validation error");
    });
  });
});
