import express from "express";
import request from "supertest";
import {
  correlationIdMiddleware,
  getCurrentCorrelationId,
  RequestWithCorrelationId,
} from "../correlationId";

describe("correlationIdMiddleware", () => {
  function buildApp() {
    const app = express();
    app.use(correlationIdMiddleware);
    app.get("/test", (req, res) => {
      res.status(200).json({
        reqCorrelationId: (req as RequestWithCorrelationId).correlationId,
        contextCorrelationId: getCurrentCorrelationId(),
      });
    });
    return app;
  }

  test("generates a UUIDv4 correlation ID when no header is provided", async () => {
    const app = buildApp();
    const response = await request(app).get("/test");

    const uuidV4Pattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    expect(response.headers["x-correlation-id"]).toMatch(uuidV4Pattern);
    expect(response.body.reqCorrelationId).toBe(response.headers["x-correlation-id"]);
  });

  test("echoes back an incoming X-Correlation-ID header instead of generating a new one", async () => {
    const app = buildApp();
    const response = await request(app)
      .get("/test")
      .set("X-Correlation-ID", "incoming-correlation-id-123");

    expect(response.headers["x-correlation-id"]).toBe("incoming-correlation-id-123");
    expect(response.body.reqCorrelationId).toBe("incoming-correlation-id-123");
  });

  test("generates a different correlation ID per request when none is supplied", async () => {
    const app = buildApp();
    const [first, second] = await Promise.all([
      request(app).get("/test"),
      request(app).get("/test"),
    ]);

    expect(first.headers["x-correlation-id"]).not.toBe(second.headers["x-correlation-id"]);
  });

  test("makes the correlation ID available via getCurrentCorrelationId() inside the request", async () => {
    const app = buildApp();
    const response = await request(app)
      .get("/test")
      .set("X-Correlation-ID", "ctx-check-id");

    expect(response.body.contextCorrelationId).toBe("ctx-check-id");
  });

  test("returns undefined from getCurrentCorrelationId() outside of any request context", () => {
    expect(getCurrentCorrelationId()).toBeUndefined();
  });

  test("handles an X-Correlation-ID header value provided as an array (Express normalization)", async () => {
    const app = express();
    app.use((req, _res, next) => {
      // Simulate the array form Express can produce for repeated headers,
      // since supertest/Node's http client always joins duplicates into a
      // single comma-separated string before the request is sent.
      req.headers["x-correlation-id"] = ["first-id", "second-id"];
      next();
    });
    app.use(correlationIdMiddleware);
    app.get("/test", (req, res) => {
      res.status(200).json({
        reqCorrelationId: (req as RequestWithCorrelationId).correlationId,
      });
    });

    const response = await request(app).get("/test");

    expect(response.body.reqCorrelationId).toBe("first-id");
  });
});
