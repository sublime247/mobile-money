import { randomUUID } from "crypto";
import express, { Request, Response, NextFunction } from "express";
import webhookRoutes from "./routes/webhook";
import { config } from "./config/env";
import logger, { requestContext } from "./logger";

const app = express();

// Preserve raw request body buffer for signature verification middleware.
app.use(
  express.json({
    verify: (req: any, _res, buf: Buffer) => {
      req.rawBody = buf;
    },
  }),
);

// ── HTTP request / response logging ─────────────────────────────────────────
// Logs every inbound request and its outcome as a structured JSON line.
// Sensitive fields (Authorization, passwords, PINs, ...) are redacted by the pino logger.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startMs = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startMs;
    const level =
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    logger[level](
      {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
        requestId: req.headers["x-request-id"] ?? undefined,
      },
      "HTTP request",
    );
  });

  // Every request gets a correlation ID (propagated or generated) so all log
  // lines it produces carry `correlationId`.
  const traceId = req.headers["x-request-id"] as string | undefined;
  const incoming = req.headers["x-correlation-id"];
  const correlationId =
    (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
  res.setHeader("X-Correlation-ID", correlationId);
  requestContext.run(
    { trace_id: traceId ?? correlationId, correlation_id: correlationId },
    () => next(),
  );
});

app.get("/", (_req: Request, res: Response) => {
  res.send("Bridge Starter API running 🚀");
});

app.use("/api", webhookRoutes);

app.listen(config.port, () => {
  logger.info({ port: config.port }, "Server started");
});
