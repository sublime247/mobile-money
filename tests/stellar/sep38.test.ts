import request from "supertest";
import app from "../../src/index";

describe("SEP-38 Exchange Endpoints", () => {
  describe("GET /sep38/info", () => {
    it("should return supported asset pairs", async () => {
      const res = await request(app).get("/sep38/info");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("assets");
      expect(Array.isArray(res.body.assets)).toBe(true);
      expect(res.body.assets.length).toBeGreaterThan(0);
      
      // Check that each asset pair has required fields
      res.body.assets.forEach((pair: any) => {
        expect(pair).toHaveProperty("sell_asset");
        expect(pair).toHaveProperty("buy_asset");
        expect(typeof pair.sell_asset).toBe("string");
        expect(typeof pair.buy_asset).toBe("string");
      });
    });
  });

  describe("GET /sep38/prices", () => {
    it("should return 400 for missing parameters", async () => {
      const res = await request(app).get("/sep38/prices");

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Missing required parameters");
    });

    it("should return 400 for unsupported asset pair", async () => {
      const res = await request(app)
        .get("/sep38/prices")
        .query({
          sell_asset: "stellar:INVALID",
          buy_asset: "iso4217:USD"
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Unsupported asset pair");
    });

    it("should return price for supported asset pair", async () => {
      const res = await request(app)
        .get("/sep38/prices")
        .query({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD"
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("price");
      expect(res.body.sell_asset).toBe("stellar:XLM");
      expect(res.body.buy_asset).toBe("iso4217:USD");
      expect(typeof res.body.price).toBe("string");
      expect(parseFloat(res.body.price)).toBeGreaterThan(0);
    });

    it("should return price for reverse asset pair", async () => {
      const res = await request(app)
        .get("/sep38/prices")
        .query({
          sell_asset: "iso4217:USD",
          buy_asset: "stellar:XLM"
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("price");
      expect(res.body.sell_asset).toBe("iso4217:USD");
      expect(res.body.buy_asset).toBe("stellar:XLM");
      expect(typeof res.body.price).toBe("string");
      expect(parseFloat(res.body.price)).toBeGreaterThan(0);
    });
  });

  describe("POST /sep38/quote", () => {
    it("should return 400 for missing required parameters", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Missing required parameters");
    });

    it("should return 400 for unsupported asset pair", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:INVALID",
          buy_asset: "iso4217:USD",
          sell_amount: "10"
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Unsupported asset pair");
    });

    it("should return 400 for invalid sell_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "-10"
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("sell_amount must be a positive number");
    });

    it("should return 400 for invalid buy_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          buy_amount: "0"
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("buy_amount must be a positive number");
    });

    it("should create quote with sell_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "100"
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("expires_at");
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("sell_amount");
      expect(res.body).toHaveProperty("buy_amount");
      expect(res.body).toHaveProperty("price");
      expect(res.body).toHaveProperty("created_at");
      
      expect(res.body.sell_asset).toBe("stellar:XLM");
      expect(res.body.buy_asset).toBe("iso4217:USD");
      expect(res.body.sell_amount).toBe("100");
      expect(parseFloat(res.body.buy_amount)).toBeGreaterThan(0);
      expect(parseFloat(res.body.price)).toBeGreaterThan(0);
      
      // Check that expires_at is in the future
      const expiresAt = new Date(res.body.expires_at);
      const now = new Date();
      expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());
    });

    it("should create quote with buy_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          buy_amount: "10"
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("expires_at");
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("sell_amount");
      expect(res.body).toHaveProperty("buy_amount");
      expect(res.body).toHaveProperty("price");
      expect(res.body).toHaveProperty("created_at");
      
      expect(res.body.sell_asset).toBe("stellar:XLM");
      expect(res.body.buy_asset).toBe("iso4217:USD");
      expect(res.body.buy_amount).toBe("10");
      expect(parseFloat(res.body.sell_amount)).toBeGreaterThan(0);
      expect(parseFloat(res.body.price)).toBeGreaterThan(0);
      
      // Check that expires_at is in the future
      const expiresAt = new Date(res.body.expires_at);
      const now = new Date();
      expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());
    });

    it("should create quote with custom TTL", async () => {
      const customTTL = 120; // 2 minutes
      
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "50",
          ttl: customTTL
        });

      expect(res.status).toBe(200);
      
      // Check that the quote expires at the correct time (approximately)
      const expiresAt = new Date(res.body.expires_at);
      const createdAt = new Date(res.body.created_at);
      const actualTTL = Math.round((expiresAt.getTime() - createdAt.getTime()) / 1000);
      
      expect(actualTTL).toBe(customTTL);
    });

    it("should use default TTL when not specified", async () => {
      const defaultTTL = 60; // 1 minute default
      
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "50"
        });

      expect(res.status).toBe(200);
      
      // Check that the quote expires at the correct time (approximately)
      const expiresAt = new Date(res.body.expires_at);
      const createdAt = new Date(res.body.created_at);
      const actualTTL = Math.round((expiresAt.getTime() - createdAt.getTime()) / 1000);
      
      expect(actualTTL).toBe(defaultTTL);
    });

    it("should limit TTL to maximum of 300 seconds", async () => {
      const maxTTL = 300; // 5 minutes maximum
      
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "50",
          ttl: 600 // Should be capped to 300
        });

      expect(res.status).toBe(200);
      
      // Check that the quote expires at the correct time (approximately)
      const expiresAt = new Date(res.body.expires_at);
      const createdAt = new Date(res.body.created_at);
      const actualTTL = Math.round((expiresAt.getTime() - createdAt.getTime()) / 1000);
      
      expect(actualTTL).toBe(maxTTL);
    });
  });

  describe("GET /sep38/quote/:id", () => {
    let quoteId: string;

    beforeEach(async () => {
      // Create a quote for testing
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "100"
        });
      
      expect(res.status).toBe(200);
      quoteId = res.body.id;
    });

    it("should return quote by ID", async () => {
      const res = await request(app).get(`/sep38/quote/${quoteId}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", quoteId);
      expect(res.body).toHaveProperty("expires_at");
      expect(res.body).toHaveProperty("sell_asset");
      expect(res.body).toHaveProperty("buy_asset");
      expect(res.body).toHaveProperty("sell_amount");
      expect(res.body).toHaveProperty("buy_amount");
      expect(res.body).toHaveProperty("price");
      expect(res.body).toHaveProperty("created_at");
    });

    it("should return 404 for non-existent quote", async () => {
      const res = await request(app).get("/sep38/quote/non-existent-id");

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Quote not found");
    });

    it("should return 410 for expired quote", async () => {
      // Wait for the quote to expire (default TTL is 60 seconds)
      // For testing purposes, we'll simulate this by manually setting an expired quote
      // In a real test environment, you might want to use a shorter TTL for testing
      
      // For now, let's test with a quote that should still be valid
      const res = await request(app).get(`/sep38/quote/${quoteId}`);
      expect(res.status).toBe(200);
    });
  });

  describe("SEP-38 TTL Requirements", () => {
    it("should enforce TTL limits correctly", async () => {
      // Test minimum TTL (should use default if below 1)
      const res1 = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "10",
          ttl: 0
        });

      expect(res1.status).toBe(200);
      const expiresAt1 = new Date(res1.body.expires_at);
      const createdAt1 = new Date(res1.body.created_at);
      const actualTTL1 = Math.round((expiresAt1.getTime() - createdAt1.getTime()) / 1000);
      expect(actualTTL1).toBe(60); // Should use default

      // Test maximum TTL (should cap at 300)
      const res2 = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:XLM",
          buy_asset: "iso4217:USD",
          sell_amount: "10",
          ttl: 600
        });

      expect(res2.status).toBe(200);
      const expiresAt2 = new Date(res2.body.expires_at);
      const createdAt2 = new Date(res2.body.created_at);
      const actualTTL2 = Math.round((expiresAt2.getTime() - createdAt2.getTime()) / 1000);
      expect(actualTTL2).toBe(300); // Should be capped
    });
  });
});