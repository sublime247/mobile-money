/**
 * Tests for the mounted SEP-38 router's (#2368) quote endpoints:
 * confirms POST /quote / GET /quote/:id are DB-backed via quoteService
 * (expires_at + status lifecycle, swept by the scheduled expiration job)
 * rather than the old sep38Service.createQuote, which only ever lived in
 * Redis/in-memory with no persisted status transitions.
 */

import request from "supertest";
import express, { Express } from "express";

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: false,
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    incrbyfloat: jest.fn(),
  },
}));

import sep38Router from "../sep38";
import { expireStaleQuotes } from "../../services/sep38/quoteService";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/sep38", sep38Router);
  return app;
}

describe("Mounted SEP-38 router — POST /quote and GET /quote/:id (#2368)", () => {
  it("creates a firm quote with status 'active' and a real expires_at", async () => {
    const app = makeApp();
    const usdc = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

    const res = await request(app).post("/sep38/quote").send({
      sell_asset: usdc,
      buy_asset: "iso4217:KES",
      sell_amount: "20.0",
      ttl: 60,
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe("active");
    expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("retrieves the created quote by ID with matching fields", async () => {
    const app = makeApp();
    const usdc = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

    const createRes = await request(app).post("/sep38/quote").send({
      sell_asset: usdc,
      buy_asset: "iso4217:NGN",
      sell_amount: "10.0",
      ttl: 60,
    });
    const quoteId = createRes.body.id;

    const getRes = await request(app).get(`/sep38/quote/${quoteId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(quoteId);
    expect(getRes.body.sell_asset).toBe(usdc);
    expect(getRes.body.buy_asset).toBe("iso4217:NGN");
    expect(getRes.body.status).toBe("active");
  });

  it("returns 404 for a quote ID that was never created", async () => {
    const app = makeApp();
    const res = await request(app).get("/sep38/quote/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("returns 410 once the quote's TTL has elapsed", async () => {
    const app = makeApp();
    const usdc = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

    const createRes = await request(app).post("/sep38/quote").send({
      sell_asset: usdc,
      buy_asset: "iso4217:NGN",
      sell_amount: "10.0",
      ttl: 10,
    });
    const quoteId = createRes.body.id;

    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 11_000);

    const getRes = await request(app).get(`/sep38/quote/${quoteId}`);
    expect(getRes.status).toBe(410);

    jest.useRealTimers();
  });

  it("the scheduled sweep (expireStaleQuotes) marks an orphaned active quote as expired", async () => {
    const app = makeApp();
    const usdc = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

    await request(app).post("/sep38/quote").send({
      sell_asset: usdc,
      buy_asset: "iso4217:XAF",
      sell_amount: "15.0",
      ttl: 10,
    });

    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 11_000);

    const swept = await expireStaleQuotes();
    expect(swept).toBeGreaterThanOrEqual(1);

    jest.useRealTimers();
  });

  it("rejects quote creation for an unsupported asset pair", async () => {
    const app = makeApp();
    const res = await request(app).post("/sep38/quote").send({
      sell_asset: "iso4217:USD",
      buy_asset: "bitcoin:BTC",
      sell_amount: "10.0",
    });

    expect(res.status).toBe(400);
  });
});
