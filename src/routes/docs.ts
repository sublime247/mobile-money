import { Router, Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { generateOpenAPIDocument } from "../openapi/generator";

export const docsRouter = Router();

const isDev = process.env.NODE_ENV === "development";

function devOnly(_req: Request, res: Response, next: () => void): void {
  if (!isDev) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

docsRouter.get("/openapi.json", devOnly, (_req: Request, res: Response) => {
  const spec = generateOpenAPIDocument();
  res.setHeader("Content-Type", "application/json");
  res.json(spec);
});

docsRouter.get("/swagger.json", devOnly, (_req: Request, res: Response) => {
  const path = require("path");
  const fs = require("fs");
  const swaggerPath = path.resolve(__dirname, "../docs/swagger.json");
  if (fs.existsSync(swaggerPath)) {
    res.sendFile(swaggerPath);
  } else {
    res.status(404).json({ error: "swagger.json not found" });
  }
});

if (isDev) {
  const localSpec = generateOpenAPIDocument();
  const useCdn = process.env.SWAGGER_CDN !== "false";

  const swaggerOptions = {
    customSiteTitle: "Mobile Money Bridge — API Docs",
    ...(useCdn && {
      customCssUrl:
        "https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui.css",
      customJs:
        "https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui-bundle.js",
    }),
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: true,
    },
  };

  docsRouter.use(
    "/",
    devOnly,
    swaggerUi.serve,
    swaggerUi.setup(
      process.env.SWAGGER_SPEC_URL
        ? { url: process.env.SWAGGER_SPEC_URL }
        : localSpec,
      swaggerOptions,
    ),
  );
} else {
  docsRouter.use("/", devOnly, (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });
}

// ---------------------------------------------------------------------------
// Signed download endpoint — issue #2461
// ---------------------------------------------------------------------------

import {
  validateSignedUrlMiddleware,
  buildSignedUrl,
} from "../utils/signedUrl.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * GET /docs/download
 *
 * Serve a KYC document or transaction export receipt via a signed URL.
 * The signed URL is generated server-side and sent to the customer out-of-band
 * (e.g. via email or the customer portal).
 *
 * Query params: doc, cid, exp, sig (produced by buildSignedUrl / generateSignedUrlParams)
 *
 * validateSignedUrlMiddleware verifies the HMAC-SHA256 signature and expiry
 * before the handler runs. Any parameter modification is detected and rejected.
 */
docsRouter.get("/download", validateSignedUrlMiddleware, (req: Request, res: Response) => {
  const documentId: string = (req as any).signedDocumentId;
  const customerId: string = (req as any).signedCustomerId;

  // Placeholder — replace with actual document retrieval (S3 pre-signed URL,
  // DB lookup, etc.)
  res.json({
    message: "Document access granted",
    documentId,
    customerId,
    accessedAt: new Date().toISOString(),
  });
});

/**
 * POST /docs/sign
 *
 * Admin / server-side route: generate a signed download URL for a document.
 * Requires authentication.  Returns the signed URL and its expiry.
 *
 * Body: { documentId: string, customerId: string, ttlSeconds?: number }
 */
docsRouter.post("/sign", requireAuth, (req: Request, res: Response) => {
  const { documentId, customerId, ttlSeconds } = req.body ?? {};

  if (!documentId || !customerId) {
    res.status(400).json({
      error: "Bad Request",
      message: "documentId and customerId are required",
    });
    return;
  }

  const expiresAt = ttlSeconds
    ? Math.floor(Date.now() / 1000) + Number(ttlSeconds)
    : undefined;

  const url = buildSignedUrl("/docs/download", {
    documentId,
    customerId,
    expiresAt,
  });

  res.json({ url, expiresAt: expiresAt ?? Math.floor(Date.now() / 1000) + 900 });
});
