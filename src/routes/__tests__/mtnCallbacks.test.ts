import { jest } from "@jest/globals";

jest.mock("../../config/appConfig", () => ({
  getConfigValue: jest.fn((key: string) => {
    if (key === "providers.mtn.callbackSecret") return "test-mtn-secret";
    if (key === "providers.mtn.callbackSignatureHeader")
      return "x-callback-signature";
    return undefined;
  }),
}));

const request = require("supertest");
const express = require("express");
import mtnCallbacksRouter from "../mtnCallbacks";
import { createHmac } from "crypto";
import { ussdPushRequestsTotal } from "../../monitoring/metrics";
import { errorHandler } from "../../middleware/errorHandler";

function buildSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
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

  it("counts a signed terminal callback once for the payer's country", async () => {
    ussdPushRequestsTotal.reset();
    const payload = {
      transactionId: "collection-123",
      status: "FAILED",
      reason: "PAYER_TIMEOUT",
      payer: { partyId: "233241234567" },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await request(app)
        .post("/api/mtn/callback")
        .set(
          "X-Callback-Signature",
          buildSignature(JSON.stringify(payload), "test-mtn-secret"),
        )
        .send(payload)
        .expect(200);
    }
    expect((await ussdPushRequestsTotal.get()).values).toEqual([
      expect.objectContaining({
        labels: { provider: "mtn", country: "GH", status: "timeout" },
        value: 1,
      }),
    ]);
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
