import fs from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import {
  createStaticCacheMiddleware,
  getOrCacheFile,
  clearStaticMemoryCache,
  computeETag,
  getMimeType,
} from "../staticCache";

describe("[Refactor] Static File Distribution Memory Cache Buffers (#1860)", () => {
  const tempDir = path.join(__dirname, "temp_static");
  const testFilePath = path.join(tempDir, "sample.html");
  const fileContent = "<html><body><h1>Static Test</h1></body></html>";

  beforeAll(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    fs.writeFileSync(testFilePath, fileContent, "utf-8");
  });

  afterAll(() => {
    clearStaticMemoryCache();
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
  });

  beforeEach(() => {
    clearStaticMemoryCache();
  });

  it("should compute correct MIME type and ETag for buffers", () => {
    expect(getMimeType("test.html")).toBe("text/html; charset=utf-8");
    expect(getMimeType("test.json")).toBe("application/json; charset=utf-8");
    const etag = computeETag(Buffer.from("hello world"));
    expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
  });

  it("should read and cache file in memory Buffer upon first access", () => {
    const cached = getOrCacheFile(testFilePath);
    expect(cached).not.toBeNull();
    expect(cached?.buffer.toString("utf-8")).toBe(fileContent);
    expect(cached?.contentType).toBe("text/html; charset=utf-8");
  });

  it("should serve static file from memory cache with ETag and Cache-Control headers", async () => {
    const app = express();
    app.use("/static", createStaticCacheMiddleware(tempDir));

    const response = await request(app).get("/static/sample.html");
    expect(response.status).toBe(200);
    expect(response.text).toBe(fileContent);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["etag"]).toBeDefined();
    expect(response.headers["cache-control"]).toContain("max-age=");
  });

  it("should return 304 Not Modified when ETag matches If-None-Match header", async () => {
    const app = express();
    app.use("/static", createStaticCacheMiddleware(tempDir));

    const firstRes = await request(app).get("/static/sample.html");
    const etag = firstRes.headers["etag"];

    const secondRes = await request(app)
      .get("/static/sample.html")
      .set("If-None-Match", etag);

    expect(secondRes.status).toBe(304);
  });

  it("should prevent directory traversal attacks", async () => {
    const app = express();
    app.use("/static", createStaticCacheMiddleware(tempDir));

    const response = await request(app).get("/static/..%2F..%2Fpackage.json");
    expect(response.status).toBe(403);
  });
});
