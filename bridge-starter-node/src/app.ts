import express, { Request, Response, NextFunction } from "express";
import webhookRoutes from "./routes/webhook";
import { config } from "./config/env";
import logger from "./logger";

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
// Sensitive headers (Authorization, etc.) are redacted by the pino logger.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startMs = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startMs;
    const level = res.statusCode >= 500 ? "error"
                : res.statusCode >= 400 ? "warn"
                : "info";

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

  next();
});

app.get("/", (_req: Request, res: Response) => {
  res.send("Bridge Starter API running 🚀");
});

app.use("/api", webhookRoutes);

app.listen(config.port, () => {
  logger.info({ port: config.port }, "Server started");
});
