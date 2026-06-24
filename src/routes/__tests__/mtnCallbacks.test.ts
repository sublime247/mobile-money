import { jest } from "@jest/globals";

jest.mock("../../config/appConfig", () => ({
  getConfigValue: jest.fn((key: string) => {
    if (key === "providers.mtn.callbackSecret") return "test-mtn-secret";
    if (key === "providers.mtn.callbackSignatureHeader") return "x-callback-signature";
    return undefined;
  }),
}));

const request = require("supertest");
const express = require("express");
import mtnCallbacksRouter from "../mtnCallbacks";
import { createHmac } from "crypto";
import { errorHandler } from "../../middleware/errorHandler";

function buildSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64");
}

describe("MTN Callback Signature Verification", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as any).rawBody = buf;
        },
      }),
    );
    app.use("/api/mtn", mtnCallbacksRouter);
    app.use(errorHandler);
  });

  it("accepts a valid MTN callback signature", async () => {
    const payload = { status: "incoming", amount: "100" };
    const payloadString = JSON.stringify(payload);
    const signature = buildSignature(payloadString, "test-mtn-secret");

    const response = await request(app)
      .post("/api/mtn/callback")
      .set("X-Callback-Signature", signature)
      .send(payload)
      .expect(200);

    expect(response.body).toEqual({ status: "accepted" });
  });

  it("rejects a callback with a missing signature", async () => {
    const response = await request(app)
      .post("/api/mtn/callback")
      .send({ status: "incoming" })
      .expect(401);

    expect(response.body.error).toBe("Unauthorized callback");
  });

  it("rejects a callback with an invalid signature", async () => {
    const payload = { status: "incoming" };
    const invalidSignature = "invalid-signature-value";

    const response = await request(app)
      .post("/api/mtn/callback")
      .set("X-Callback-Signature", invalidSignature)
      .send(payload)
      .expect(401);

    expect(response.body.error).toBe("Unauthorized callback");
  });
});
