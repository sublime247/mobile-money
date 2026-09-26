import { Router, Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { generateOpenAPIDocument } from "../openapi/generator";

export const docsRouter = Router();

// Rate limiter for documentation endpoints to prevent resource exhaustion / DoS
export const docsRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: {
    error: "Too Many Requests",
    message: "Too many requests to documentation endpoints, please try again later",
  },
});

docsRouter.use(docsRateLimiter);

const openApiYamlPath = path.resolve(process.cwd(), "docs/openapi.yaml");

// In-memory cache for OpenAPI spec and raw files to avoid uncontrolled fs I/O
let cachedOpenApiYaml: string | null = null;
let cachedOpenApiSpec: Record<string, unknown> | null = null;

try {
  if (fs.existsSync(openApiYamlPath)) {
    cachedOpenApiYaml = fs.readFileSync(openApiYamlPath, "utf-8");
    const parsed = yaml.load(cachedOpenApiYaml);
    if (parsed && typeof parsed === "object") {
      cachedOpenApiSpec = parsed as Record<string, unknown>;
    }
  }
} catch (err) {
  console.warn("Failed to load docs/openapi.yaml at startup:", err);
  cachedOpenApiYaml = null;
  cachedOpenApiSpec = null;
}

function getOpenApiSpec(): Record<string, unknown> {
  if (cachedOpenApiSpec) {
    return cachedOpenApiSpec;
  }
  return generateOpenAPIDocument();
}

// Serve raw YAML specification with rate limiting
docsRouter.get("/openapi.yaml", docsRateLimiter, (_req: Request, res: Response) => {
  if (cachedOpenApiYaml !== null) {
    res.setHeader("Content-Type", "text/yaml; charset=utf-8");
    res.send(cachedOpenApiYaml);
  } else {
    res.status(404).json({ error: "openapi.yaml not found" });
  }
});

// Serve OpenAPI 3.1 JSON specification with rate limiting
docsRouter.get("/openapi.json", docsRateLimiter, (_req: Request, res: Response) => {
  const spec = getOpenApiSpec();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json(spec);
});

// Legacy swagger.json endpoint with rate limiting
let cachedSwaggerJson: string | null = null;
const swaggerPath = path.resolve(__dirname, "../docs/swagger.json");
try {
  if (fs.existsSync(swaggerPath)) {
    cachedSwaggerJson = fs.readFileSync(swaggerPath, "utf-8");
  }
} catch {
  cachedSwaggerJson = null;
}

docsRouter.get("/swagger.json", docsRateLimiter, (_req: Request, res: Response) => {
  if (cachedSwaggerJson !== null) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(cachedSwaggerJson);
  } else {
    const spec = getOpenApiSpec();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json(spec);
  }
});

// Sandbox mock responses handler for Try it Out mode
docsRouter.all("/sandbox/*", (req: Request, res: Response) => {
  const subPath = req.path.replace(/^\/sandbox/, "");
  if (subPath.includes("deposit")) {
    return res.status(200).json({
      type: "interactive_customer_info_needed",
      url: "https://bridge.stellarwave.io/sep24/flow?token=sandbox-mock-deposit-token",
      id: "sandbox-tx-" + Date.now(),
      status: "pending_user_transfer_start",
    });
  }
  if (subPath.includes("quote")) {
    return res.status(201).json({
      id: "sandbox-quote-" + Date.now(),
      price: "600.0",
      total_price: "602.5",
      sell_asset: "iso4217:XAF",
      sell_amount: "60250",
      buy_asset: "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      buy_amount: "100.0",
      expires_at: new Date(Date.now() + 900000).toISOString(),
    });
  }
  if (subPath.includes("customer")) {
    return res.status(200).json({
      id: "sandbox-cust-1234",
      status: "ACCEPTED",
      message: "Customer verified in sandbox mode",
    });
  }
  if (subPath.includes("auth")) {
    return res.status(200).json({
      transaction: "AAAAAgAAAABmockSandboxChallengeXdr...",
      network_passphrase: "Test SDF Network ; September 2015",
    });
  }
  return res.status(200).json({
    status: "ok",
    mode: "sandbox",
    received: {
      method: req.method,
      path: subPath,
      body: req.body,
    },
  });
});

// Swagger UI options with Try it Out enabled
const useCdn = process.env.SWAGGER_CDN !== "false";
const swaggerOptions = {
  customSiteTitle: "Mobile Money Stellar Bridge — Interactive API Docs",
  ...(useCdn && {
    customCssUrl: "https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui.css",
    customJs: "https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui-bundle.js",
  }),
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
    showExtensions: true,
    showCommonExtensions: true,
  },
};

// Serve Swagger UI
docsRouter.use(
  "/",
  swaggerUi.serve,
  (req: Request, res: Response, next: () => void) => {
    const spec = getOpenApiSpec();
    const setupHandler = swaggerUi.setup(
      process.env.SWAGGER_SPEC_URL ? { url: process.env.SWAGGER_SPEC_URL } : spec,
      swaggerOptions
    );
    setupHandler(req, res, next);
  }
);
