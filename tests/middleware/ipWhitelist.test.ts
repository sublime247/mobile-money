import express from "express";
import request from "supertest";
import { ipWhitelist } from "../../src/middleware/ipWhitelist";

describe("ipWhitelist middleware", () => {
  const app = express();
  app.post("/webhook", ipWhitelist, (_req, res) =>
    res.status(200).json({ ok: true }),
  );

  it("allows requests from known CIDRs", async () => {
    await request(app)
      .post("/webhook")
      .set("X-Forwarded-For", "41.134.10.10")
      .send({})
      .expect(200, { ok: true });
  });

  it("blocks unknown IPs", async () => {
    await request(app)
      .post("/webhook")
      .set("X-Forwarded-For", "203.0.113.1")
      .send({})
      .expect(403, { error: "Forbidden" });
  });
});
