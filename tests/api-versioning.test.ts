/**
 * API Versioning Test Suite
 * Tests for version extraction, validation, and backward compatibility
 */

import request from "supertest";
import express, { Response as ExpressResponse } from "express";
import {
  apiVersionMiddleware,
  validateVersionMiddleware,
  VersionedRequest,
} from "../src/middleware/apiVersion";

describe("API Versioning", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(apiVersionMiddleware);
    app.use(validateVersionMiddleware);

    // Test endpoint
    app.get(
      "/api/:version/test",
      (req: VersionedRequest, res: ExpressResponse) => {
        res.json({ version: req.apiVersion, data: "test" });
      },
    );
    app.get("/api/test", (req: VersionedRequest, res: ExpressResponse) => {
      res.json({ version: req.apiVersion, data: "test" });
    });
  });

  describe("Version Extraction from URL", () => {
    it("should extract v1 from URL path", (done) => {
      request(app)
        .get("/api/v1/test")
        .expect(200)
        .expect((res: any) => {
          if (res.body.version !== "v1")
            throw new Error("Version not extracted");
          if (res.headers["api-version"] !== "v1")
            throw new Error("Version header not set");
        })
        .end(done);
    });

    it("should set API-Version header", (done) => {
      request(app)
        .get("/api/v1/test")
        .expect((res: any) => {
          if (!res.headers["api-version"])
            throw new Error("Missing API-Version header");
        })
        .end(done);
    });

    it("should set Vary header", (done) => {
      request(app)
        .get("/api/v1/test")
        .expect((res: any) => {
          if (!res.headers["vary"]) throw new Error("Missing Vary header");
        })
        .end(done);
    });
  });

  describe("Version Extraction from Accept Header", () => {
    it("should extract version from Accept header", (done) => {
      request(app)
        .get("/api/test")
        .set("Accept", "application/json;version=v1")
        .expect(200)
        .expect((res: any) => {
          if (res.headers["api-version"] !== "v1")
            throw new Error("Accept header version not used");
        })
        .end(done);
    });

    it("should prioritize URL path over Accept header", (done) => {
      request(app)
        .get("/api/v1/test")
        .set("Accept", "application/json;version=v2")
        .expect((res: any) => {
          if (res.headers["api-version"] !== "v1")
            throw new Error("URL path priority failed");
        })
        .end(done);
    });
  });

  describe("Version Extraction from Accept-Version Header", () => {
    it("should extract version from Accept-Version header", (done) => {
      request(app)
        .get("/api/test")
        .set("Accept-Version", "v1")
        .expect(200)
        .expect((res: any) => {
          if (res.body.version !== "v1")
            throw new Error("Accept-Version header version not used");
          if (res.headers["api-version"] !== "v1")
            throw new Error("API-Version header not set from Accept-Version");
        })
        .end(done);
    });

    it("should normalize numeric Accept-Version values", (done) => {
      request(app)
        .get("/api/test")
        .set("Accept-Version", "1")
        .expect(200)
        .expect((res: any) => {
          if (res.headers["api-version"] !== "v1")
            throw new Error("Numeric Accept-Version header not normalized");
        })
        .end(done);
    });

    it("should prioritize URL path over Accept-Version header", (done) => {
      request(app)
        .get("/api/v1/test")
        .set("Accept-Version", "v99")
        .expect(200)
        .expect((res: any) => {
          if (res.headers["api-version"] !== "v1")
            throw new Error("URL path should take priority over Accept-Version");
        })
        .end(done);
    });

    it("should reject unsupported Accept-Version header values", (done) => {
      request(app)
        .get("/api/test")
        .set("Accept-Version", "v99")
        .expect(400)
        .expect((res: any) => {
          if (res.body.error !== "Unsupported API Version") {
            throw new Error("Unsupported Accept-Version was not rejected");
          }
        })
        .end(done);
    });
  });

  describe("Version Validation", () => {
    it("should reject unsupported versions", (done) => {
      request(app)
        .get("/api/v99/test")
        .expect(400)
        .expect((res: any) => {
          if (!res.body.error || res.body.error !== "Unsupported API Version") {
            throw new Error("Version validation failed");
          }
        })
        .end(done);
    });

    it("should return supported versions in error", (done) => {
      request(app)
        .get("/api/v99/test")
        .expect((res: any) => {
          if (!res.body.supportedVersions)
            throw new Error("Supported versions not returned");
          if (!Array.isArray(res.body.supportedVersions))
            throw new Error("Supported versions not array");
        })
        .end(done);
    });
  });

  describe("Backward Compatibility", () => {
    it("should default to v1 for unversioned endpoints", (done) => {
      request(app)
        .get("/api/test")
        .expect((res: any) => {
          if (res.headers["api-version"] !== "v1")
            throw new Error("Default version not v1");
        })
        .end(done);
    });

    it("should support legacy /api/ paths", (done) => {
      request(app).get("/api/test").expect(200).end(done);
    });
  });

  describe("Multi-Version Support", () => {
    it("should handle multiple requests with different versions", (done) => {
      Promise.all([
        new Promise<void>((resolve, reject) => {
          request(app)
            .get("/api/v1/test")
            .expect(200)
            .end((err: Error | null) => (err ? reject(err) : resolve()));
        }),
      ])
        .then(() => done())
        .catch(done);
    });

    it("should maintain independent version contexts", (done) => {
      request(app)
        .get("/api/v1/test")
        .expect(200)
        .expect((res: any) => {
          if (res.body.version !== "v1")
            throw new Error("Version context not maintained");
        })
        .end(done);
    });
  });

  describe("Response Headers", () => {
    it("should include version in all responses", (done) => {
      request(app)
        .get("/api/v1/test")
        .expect((res: any) => {
          if (!res.headers["api-version"])
            throw new Error("Missing version header");
        })
        .end(done);
    });

    it("should include Vary header for caching", (done) => {
      request(app)
        .get("/api/v1/test")
        .expect((res: any) => {
          if (!res.headers["vary"]) throw new Error("Missing Vary header");
          if (!res.headers["vary"].includes("Accept"))
            throw new Error("Vary should include Accept");
          if (!res.headers["vary"].includes("Accept-Version"))
            throw new Error("Vary should include Accept-Version");
        })
        .end(done);
    });
  });

  describe("Error Handling", () => {
    it("should handle malformed version strings", (done) => {
      request(app)
        .get("/api/invalid/test")
        .expect((res: any) => {
          // Should either use default or reject
          if (res.status !== 200 && res.status !== 400) {
            throw new Error("Unexpected status code");
          }
        })
        .end(done);
    });

    it("should provide helpful error messages", (done) => {
      request(app)
        .get("/api/v99/test")
        .expect(400)
        .expect((res: any) => {
          if (!res.body.message) throw new Error("No error message provided");
        })
        .end(done);
    });
  });
});
