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

// ── Standardized error handler ───────────────────────────────────────────────
// Aligns error responses with the main API bridge fields so developer
// experience is consistent across both the starter template and the main API.
//
// Response shape:
//   {
//     "success": false,
//     "error":   <string — human-readable>,
//     "code":    <string — machine-readable, e.g. "INTERNAL_ERROR">,
//     "status":  <number — mirrors HTTP status>,
//     "requestId": <string | undefined — from x-request-id header>
//   }
interface BridgeErrorBody {
  success: false;
  error: string;
  code: string;
  status: number;
  requestId?: string;
  details?: Record<string, unknown>;
}

app.use((err: Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }, req: Request, res: Response, _next: NextFunction) => {
  const statusCode =
    typeof err.statusCode === "number" && err.statusCode >= 400
      ? err.statusCode
      : 500;

  const code = err.code ?? (statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST");
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? undefined;

  logger.error(
    {
      code,
      statusCode,
      requestId,
      message: err.message,
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    },
    "Request error",
  );

  const body: BridgeErrorBody = {
    success: false,
    error: err.message || "An unexpected error occurred",
    code,
    status: statusCode,
    requestId,
  };

  // Include details only outside production to avoid leaking internals.
  if (process.env.NODE_ENV !== "production" && err.details) {
    body.details = err.details;
  }

  res.status(statusCode).json(body);
});

app.listen(config.port, () => {
  logger.info({ port: config.port }, "Server started");
});

