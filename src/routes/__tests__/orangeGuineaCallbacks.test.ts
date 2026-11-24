import { jest } from "@jest/globals";

jest.mock("../../config/appConfig", () => ({
  getConfigValue: jest.fn((key: string) => {
    if (key === "providers.orangeGuinea.callbackSecret")
      return "test-og-secret";
    if (key === "providers.orangeGuinea.callbackSignatureHeader")
      return "x-callback-signature";
    return undefined;
  }),
}));

const request = require("supertest");
import express, { Application } from "express";
import orangeGuineaCallbacksRouter from "../orangeGuineaCallbacks";
import { createHmac } from "crypto";
import { errorHandler } from "../../middleware/errorHandler";

function buildSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64");
}

const FRESH_TIMESTAMP = String(Math.floor(Date.now() / 1000));

describe("Orange Guinea Callback Routes", () => {
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
    app.use("/api/orange-guinea", orangeGuineaCallbacksRouter);
    app.use(errorHandler);
  });

  describe("POST /api/orange-guinea/callback", () => {
    it("accepts a valid callback with correct signature", async () => {
      const payload = { reference: "ref-1", status: "SUCCESSFUL" };
      const signature = buildSignature(
        JSON.stringify(payload),
        "test-og-secret",
      );

      const response = await request(app)
        .post("/api/orange-guinea/callback")
        .set("X-Callback-Signature", signature)
        .set("X-Orange-Timestamp", FRESH_TIMESTAMP)
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({ status: "accepted" });
    });

    it("accepts a callback with optional fields", async () => {
      const payload = {
        reference: "ref-2",
        status: "IN_PROGRESS",
        transactionId: "txn-001",
        amount: 5000,
        currency: "GNF",
        msisdn: "+224620000000",
      };
      const signature = buildSignature(
        JSON.stringify(payload),
        "test-og-secret",
      );

      const response = await request(app)
        .post("/api/orange-guinea/callback")
        .set("X-Callback-Signature", signature)
        .set("X-Orange-Timestamp", FRESH_TIMESTAMP)
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({ status: "accepted" });
    });

    it("rejects a callback with missing signature", async () => {
      const response = await request(app)
        .post("/api/orange-guinea/callback")
        .send({ reference: "ref-1", status: "SUCCESSFUL" })
        .expect(401);

      expect(response.body.error).toBe("Unauthorized callback");
    });

    it("rejects a callback with invalid signature", async () => {
      const response = await request(app)
        .post("/api/orange-guinea/callback")
        .set("X-Callback-Signature", "invalid-sig")
        .send({ reference: "ref-1", status: "SUCCESSFUL" })
        .expect(401);

      expect(response.body.error).toBe("Unauthorized callback");
    });

    it("rejects a callback with an invalid status value", async () => {
      const payload = { reference: "ref-1", status: "INVALID_STATUS" };
      const signature = buildSignature(
        JSON.stringify(payload),
        "test-og-secret",
      );

      const response = await request(app)
        .post("/api/orange-guinea/callback")
        .set("X-Callback-Signature", signature)
        .set("X-Orange-Timestamp", FRESH_TIMESTAMP)
        .send(payload)
        .expect(400);

      expect(response.body.error).toBe("Validation error");
    });

    it("rejects a callback missing the required reference field", async () => {
      const payload = { status: "SUCCESSFUL" };
      const signature = buildSignature(
        JSON.stringify(payload),
        "test-og-secret",
      );

      const response = await request(app)
        .post("/api/orange-guinea/callback")
        .set("X-Callback-Signature", signature)
        .set("X-Orange-Timestamp", FRESH_TIMESTAMP)
        .send(payload)
        .expect(400);

      expect(response.body.error).toBe("Validation error");
    });
  });

  describe("POST /api/orange-guinea/callback/batch", () => {
    it("accepts a valid batch callback", async () => {
      const payload = {
        batchId: "batch-1",
        items: [
          { referenceId: "tx1", status: "SUCCESSFUL", transactionId: "pmt-1" },
          { referenceId: "tx2", status: "FAILED", errorReason: "timeout" },
        ],
      };
      const signature = buildSignature(
        JSON.stringify(payload),
        "test-og-secret",
      );

      const response = await request(app)
        .post("/api/orange-guinea/callback/batch")
        .set("X-Callback-Signature", signature)
        .set("X-Orange-Timestamp", FRESH_TIMESTAMP)
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({ status: "accepted" });
    });

    it("rejects a batch callback missing batchId", async () => {
      const payload = { items: [] };
      const signature = buildSignature(
        JSON.stringify(payload),
        "test-og-secret",
      );

      const response = await request(app)
        .post("/api/orange-guinea/callback/batch")
        .set("X-Callback-Signature", signature)
        .set("X-Orange-Timestamp", FRESH_TIMESTAMP)
        .send(payload)
        .expect(400);

      expect(response.body.error).toBe("Validation error");
    });
  });
});
