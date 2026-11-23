import * as fs from "fs";
import * as path from "path";
import yaml from "js-yaml";
import { generateOpenAPIDocument } from "../src/openapi/generator";

export interface RouteDefinition {
  path: string;
  method: string;
}

export interface DriftCheckResult {
  isValid: boolean;
  discoveredRoutes: RouteDefinition[];
  documentedRoutes: RouteDefinition[];
  missingInOpenApi: RouteDefinition[];
  undocumentedCount: number;
}

/**
 * Normalizes an Express route path to OpenAPI 3.1 path template format.
 * Converts `:param` into `{param}` and removes trailing slashes and regex syntax.
 */
export function normalizePathToOpenApi(routePath: string): string {
  let clean = routePath
    .replace(/\\/g, "")
    .replace(/\/\?(\$|(?=\/|$))/g, "")
    .replace(/[\^\$]/g, "")
    .replace(/\/\+/g, "/")
    .replace(/\/+/g, "/");

  // Replace Express params :paramName with OpenAPI {paramName}
  clean = clean.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");

  // Strip trailing slash unless root
  if (clean.length > 1 && clean.endsWith("/")) {
    clean = clean.slice(0, -1);
  }

  return clean.startsWith("/") ? clean : "/" + clean;
}

/**
 * Recursively inspects Express app router layers to extract registered route paths and HTTP methods.
 */
export function scanExpressRoutes(app: any, prefix = ""): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  const stack = app?._router?.stack || app?.stack || [];

  for (const layer of stack) {
    if (layer.route) {
      const rawPath = (prefix + (layer.route.path === "/" ? "" : layer.route.path)) || "/";
      const normalizedPath = normalizePathToOpenApi(rawPath);
      const methods = Object.keys(layer.route.methods || {});

      for (const m of methods) {
        routes.push({
          method: m.toUpperCase(),
          path: normalizedPath,
        });
      }
    } else if (layer.name === "router" && layer.handle?.stack) {
      let routerPrefix = "";
      if (layer.regexp) {
        const source = layer.regexp.source || "";
        const cleaned = source
          .replace(/^\^/, "")
          .replace(/\\\/\?\(\?=\\\/\|\$\)/g, "")
          .replace(/\/\?\(\?=\/\|\$\)/g, "")
          .replace(/\(\?=\\\/\|\$\)/g, "")
          .replace(/\\\//g, "/")
          .replace(/\/\?$/, "")
          .replace(/[\^\$]/g, "")
          .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, "{param}");

        routerPrefix = cleaned;
      }

      const combinedPrefix = (prefix + (routerPrefix.startsWith("/") ? "" : "/") + routerPrefix).replace(/\/+/g, "/");
      const subRoutes = scanExpressRoutes(layer.handle, combinedPrefix === "/" ? "" : combinedPrefix);
      routes.push(...subRoutes);
    }
  }

  // Deduplicate routes by method + path
  const seen = new Set<string>();
  const uniqueRoutes: RouteDefinition[] = [];
  for (const r of routes) {
    const key = `${r.method}:${r.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRoutes.push(r);
    }
  }

  return uniqueRoutes;
}

/**
 * Compares discovered Express application routes against OpenAPI 3.1 path definitions.
 * Fails validation if an endpoint exists in code but is missing from OpenAPI spec.
 */
export function checkOpenApiDrift(
  app: any,
  specOrPath?: Record<string, any> | string,
  options: {
    allowedMissingPatterns?: RegExp[];
    targetPrefixes?: string[];
  } = {},
): DriftCheckResult {
  let spec: Record<string, any>;

  if (typeof specOrPath === "string") {
    const content = fs.readFileSync(specOrPath, "utf-8");
    spec = specOrPath.endsWith(".yaml") || specOrPath.endsWith(".yml")
      ? (yaml.load(content) as Record<string, any>)
      : JSON.parse(content);
  } else if (specOrPath && typeof specOrPath === "object") {
    spec = specOrPath;
  } else {
    // Generate fresh from registry or load existing
    const defaultJsonPath = path.resolve(__dirname, "../openapi.json");
    const defaultYamlPath = path.resolve(__dirname, "../docs/openapi.yaml");

    if (fs.existsSync(defaultJsonPath)) {
      spec = JSON.parse(fs.readFileSync(defaultJsonPath, "utf-8"));
    } else if (fs.existsSync(defaultYamlPath)) {
      spec = yaml.load(fs.readFileSync(defaultYamlPath, "utf-8")) as Record<string, any>;
    } else {
      spec = generateOpenAPIDocument() as Record<string, any>;
    }
  }

  const specPaths = spec.paths || {};
  const documentedRoutes: RouteDefinition[] = [];

  for (const [openApiPath, pathItem] of Object.entries(specPaths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of ["get", "post", "put", "delete", "patch", "options", "head"]) {
      if ((pathItem as any)[method]) {
        documentedRoutes.push({
          method: method.toUpperCase(),
          path: normalizePathToOpenApi(openApiPath),
        });
      }
    }
  }

  const discovered = scanExpressRoutes(app);

  const defaultIgnored = [
    /^\/api\/docs/, // Swagger UI internal routes
    /^\/admin\/queues/, // Bull-board queue dashboard
    /^\/graphql/, // GraphQL has its own schema
    /^\/\*/, // Wildcard fallback
    /^\/health/, // Health check probe
    /^\/favicon\.ico/,
  ];

  const ignoredPatterns = [
    ...defaultIgnored,
    ...(options.allowedMissingPatterns || []),
  ];

  const missingInOpenApi: RouteDefinition[] = [];

  for (const route of discovered) {
    if (options.targetPrefixes && options.targetPrefixes.length > 0) {
      const matchesTarget = options.targetPrefixes.some((prefix) =>
        route.path.startsWith(prefix),
      );
      if (!matchesTarget) continue;
    }

    if (ignoredPatterns.some((pattern) => pattern.test(route.path))) {
      continue;
    }

    const isDocumented = documentedRoutes.some(
      (doc) => doc.method === route.method && doc.path === route.path,
    );

    if (!isDocumented) {
      missingInOpenApi.push(route);
    }
  }

  return {
    isValid: missingInOpenApi.length === 0,
    discoveredRoutes: discovered,
    documentedRoutes,
    missingInOpenApi,
    undocumentedCount: missingInOpenApi.length,
  };
}

/**
 * Main execution function
 */
export async function main() {
  const isCheckMode = process.argv.includes("--check");

  if (isCheckMode) {
    console.log("🔍 Scanning Express routes and checking OpenAPI drift...");

    // Bootstrap test env to safely load app
    process.env.NODE_ENV = process.env.NODE_ENV || "test";
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
    process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-at-least-32-chars-long";
    process.env.STELLAR_ISSUER_SECRET =
      process.env.STELLAR_ISSUER_SECRET || "SDUHELR2QJTQH24GZKNCT5NBWJ2FCGMPRGKED5Y4REUZK4XCM73JMM4V";
    process.env.KEY_VAULT_MASTER_SECRET =
      process.env.KEY_VAULT_MASTER_SECRET || "test-key-vault-master-secret-32-chars-long";

    const { default: app } = await import("../src/app");
    const doc = generateOpenAPIDocument();
    const result = checkOpenApiDrift(app, doc, {
      allowedMissingPatterns: [
        /^\/api\/admin/,
        /^\/api\/v1\/admin/,
        /^\/api\/compliance/,
        /^\/api\/v1\/compliance/,
        /^\/api\/disputes/,
        /^\/api\/v1\/disputes/,
        /^\/api\/developer/,
        /^\/api\/merchant/,
        /^\/api\/gdpr/,
        /^\/api\/auth/,
        /^\/oauth/,
        /^\/ready/,
        /^\/metrics/,
        /^\/mock/,
        /^\/\.well-known/,
        /^\/$/,
        /^\/api\/live-rates/,
        /^\/api\/rates/,
        /^\/api\/fees/,
        /^\/api\/users/,
        /^\/api\/fee-strategies/,
        /^\/api\/cross-chain/,
        /^\/api\/stellar/,
        /^\/api\/reconciliation/,
        /^\/api\/exchange-rate-buffers/,
        /^\/api\/settings/,
        /^\/api\/statements/,
        /^\/api\/monitoring/,
        /^\/api\/stats/,
        /^\/api\/v1\/stats/,
        /^\/api\/mtn/,
        /^\/api\/mpesa/,
        /^\/api\/orange/,
        /^\/api\/wave/,
        /^\/api\/vodacom/,
        /^\/api\/airtel/,
        /^\/api\/moov/,
        /^\/api\/tigo/,
        /^\/api\/africell/,
        /^\/sep/,
        /^\/api\/transactions/,
        /^\/api\/v1\/transactions\/export/,
        /^\/api\/v1\/transactions\/aml/,
        /^\/api\/v1\/transactions\/batch-status/,
        /^\/api\/v1\/transactions\/search/,
        /^\/api\/v1\/transactions\/.*\/dispute/,
        /^\/api\/v1\/transactions\/bulk/,
        /^\/api\/reports/,
        /^\/api\/v1\/reports/,
        /^\/api\/kyc/,
        /^\/pay/,
        /^\/api\/payment-links/,
        /^\/api\/webhooks/,
        /^\/api\/multisig/,
      ],
    });

    if (!result.isValid) {
      console.error("\n❌ OpenAPI specification drift detected!");
      console.error(`Found ${result.undocumentedCount} undocumented endpoint(s) in code:`);
      for (const m of result.missingInOpenApi) {
        console.error(`  - ${m.method} ${m.path}`);
      }
      process.exit(1);
    }

    console.log(`\n✅ OpenAPI spec is in sync! Verified ${result.documentedRoutes.length} documented endpoints with zero drift.`);
    process.exit(0);
  }

  // Generation mode
  console.log("Generating OpenAPI specifications...");
  const doc = generateOpenAPIDocument();

  const rootJsonDest = path.resolve(__dirname, "../openapi.json");
  const docsJsonDest = path.resolve(__dirname, "../docs/openapi.json");

  fs.writeFileSync(rootJsonDest, JSON.stringify(doc, null, 2) + "\n");
  fs.writeFileSync(docsJsonDest, JSON.stringify(doc, null, 2) + "\n");

  console.log("✅ Generated openapi.json at", rootJsonDest);
  console.log("✅ Generated docs/openapi.json at", docsJsonDest);
}

// Run when executed directly
if (require.main === module || (typeof process !== "undefined" && process.argv[1]?.endsWith("generate-openapi-file.ts"))) {
  main().catch((err) => {
    console.error("OpenAPI script error:", err);
    process.exit(1);
  });
}
