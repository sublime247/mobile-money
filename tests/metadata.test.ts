import request from "supertest";
import app from "../src/index";

describe("Transaction Metadata – JSONB field", () => {
  // ── PUT /:id/metadata — Replace ─────────────────────────────────────

  describe("PUT /api/transactions/:id/metadata", () => {
    it("should return 400 when metadata is missing from body", async () => {
      const res = await request(app)
        .put("/api/transactions/00000000-0000-0000-0000-000000000001/metadata")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("metadata");
    });

    it("should return 400 when metadata is not an object", async () => {
      const res = await request(app)
        .put("/api/transactions/00000000-0000-0000-0000-000000000001/metadata")
        .send({ metadata: "string-value" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("JSON object");
    });

    it("should return 400 when metadata is an array", async () => {
      const res = await request(app)
        .put("/api/transactions/00000000-0000-0000-0000-000000000001/metadata")
        .send({ metadata: [1, 2, 3] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("JSON object");
    });

    it("should return 400 when metadata exceeds 10 KB", async () => {
      // Build a >10 KB JSON object
      const big: Record<string, string> = {};
      for (let i = 0; i < 200; i++) {
        big[`key_${i}`] = "x".repeat(60);
      }
      const res = await request(app)
        .put("/api/transactions/00000000-0000-0000-0000-000000000001/metadata")
        .send({ metadata: big });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("size");
    });
  });

  // ── PATCH /:id/metadata — Merge ─────────────────────────────────────

  describe("PATCH /api/transactions/:id/metadata", () => {
    it("should return 400 when metadata is missing from body", async () => {
      const res = await request(app)
        .patch(
          "/api/transactions/00000000-0000-0000-0000-000000000001/metadata",
        )
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("metadata");
    });

    it("should return 400 when metadata is not an object", async () => {
      const res = await request(app)
        .patch(
          "/api/transactions/00000000-0000-0000-0000-000000000001/metadata",
        )
        .send({ metadata: 42 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("JSON object");
    });
  });

  // ── DELETE /:id/metadata — Remove keys ──────────────────────────────

  describe("DELETE /api/transactions/:id/metadata", () => {
    it("should return 400 when keys is not an array", async () => {
      const res = await request(app)
        .delete(
          "/api/transactions/00000000-0000-0000-0000-000000000001/metadata",
        )
        .send({ keys: "not-an-array" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("array of strings");
    });

    it("should return 400 when keys contains non-string values", async () => {
      const res = await request(app)
        .delete(
          "/api/transactions/00000000-0000-0000-0000-000000000001/metadata",
        )
        .send({ keys: [1, 2] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("array of strings");
    });
  });

  // ── POST /search/metadata — Query ───────────────────────────────────

  describe("POST /api/transactions/search/metadata", () => {
    it("should return 400 when filter is missing", async () => {
      const res = await request(app)
        .post("/api/transactions/search/metadata")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("filter");
    });

    it("should return 400 when filter is not an object", async () => {
      const res = await request(app)
        .post("/api/transactions/search/metadata")
        .send({ filter: "invalid" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("JSON object");
    });

    it("should return 400 when filter is an array", async () => {
      const res = await request(app)
        .post("/api/transactions/search/metadata")
        .send({ filter: [{ key: "val" }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("JSON object");
    });
  });

  // ── V1 routes mirror ───────────────────────────────────────────────

  describe("V1 routes – /api/v1/transactions", () => {
    it("PUT /:id/metadata should return 400 for invalid input", async () => {
      const res = await request(app)
        .put(
          "/api/v1/transactions/00000000-0000-0000-0000-000000000001/metadata",
        )
        .send({ metadata: null });
      expect(res.status).toBe(400);
    });

    it("POST /search/metadata should return 400 for missing filter", async () => {
      const res = await request(app)
        .post("/api/v1/transactions/search/metadata")
        .send({});
      expect(res.status).toBe(400);
    });
  });
});
