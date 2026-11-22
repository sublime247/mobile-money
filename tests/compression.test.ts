import express from "express";
import request from "supertest";
import {
  compressionMiddleware,
  createCompressionMiddleware,
} from "../src/middleware/compression";
import { app as exportedApp } from "../src/app";

function createCompressionApp(compressionEnabled = true) {
  const app = express();

  if (compressionEnabled) {
    app.use(createCompressionMiddleware({ threshold: 1024, level: 6 }));
  }

  app.get("/large", (_req, res) => {
    res.type("application/json");
    res.json({ data: "x".repeat(4000) });
  });

  app.get("/small", (_req, res) => {
    res.type("application/json");
    res.json({ ok: true });
  });

  app.get("/image", (_req, res) => {
    res.type("image/png");
    res.send(Buffer.alloc(2000, 1));
  });

  return app;
}

describe("Compression Middleware", () => {
  describe("Gzip Compression", () => {
    it("should compress large responses using gzip", async () => {
      const response = await request(createCompressionApp())
        .get("/large")
        .set("Accept-Encoding", "gzip")
        .expect(200);

      expect(response.headers["content-encoding"]).toBe("gzip");
    });

    it("should not compress small responses under 1024 bytes", async () => {
      const response = await request(createCompressionApp())
        .get("/small")
        .set("Accept-Encoding", "gzip")
        .expect(200);

      expect(response.headers["content-encoding"]).toBeUndefined();
    });

    it("should respect x-no-compression header for gzip", async () => {
      const response = await request(createCompressionApp())
        .get("/large")
        .set("Accept-Encoding", "gzip")
        .set("x-no-compression", "true")
        .expect(200);

      expect(response.headers["content-encoding"]).toBeUndefined();
    });
  });

  describe("Brotli Compression", () => {
    it("should compress large responses using brotli (br)", async () => {
      const response = await request(createCompressionApp())
        .get("/large")
        .set("Accept-Encoding", "br")
        .expect(200);

      expect(response.headers["content-encoding"]).toBe("br");
    });

    it("should not compress small responses under 1024 bytes with brotli", async () => {
      const response = await request(createCompressionApp())
        .get("/small")
        .set("Accept-Encoding", "br")
        .expect(200);

      expect(response.headers["content-encoding"]).toBeUndefined();
    });

    it("should respect x-no-compression header for brotli", async () => {
      const response = await request(createCompressionApp())
        .get("/large")
        .set("Accept-Encoding", "br")
        .set("x-no-compression", "true")
        .expect(200);

      expect(response.headers["content-encoding"]).toBeUndefined();
    });

    it("should prefer brotli when both br and gzip are supported", async () => {
      const response = await request(createCompressionApp())
        .get("/large")
        .set("Accept-Encoding", "gzip, deflate, br")
        .expect(200);

      expect(response.headers["content-encoding"]).toBe("br");
    });
  });

  describe("Content Filtering & Bypass", () => {
    it("should not compress already-compressed content types (e.g. image/png)", async () => {
      const response = await request(createCompressionApp())
        .get("/image")
        .set("Accept-Encoding", "br, gzip")
        .expect(200);

      expect(response.headers["content-encoding"]).toBeUndefined();
    });

    it("should work with compression disabled", async () => {
      const response = await request(createCompressionApp(false))
        .get("/large")
        .set("Accept-Encoding", "br, gzip")
        .expect(200);

      expect(response.headers["content-encoding"]).toBeUndefined();
    });
  });

  describe("App Integration", () => {
    it("should export compressionMiddleware and configured app instance", () => {
      expect(compressionMiddleware).toBeDefined();
      expect(typeof compressionMiddleware).toBe("function");
      expect(exportedApp).toBeDefined();
    });
  });
});
