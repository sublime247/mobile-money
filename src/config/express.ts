/**
 * @file src/config/express.ts
 *
 * Hardened Express security configuration.
 *
 * Targets an A+ rating on Mozilla Observatory by enforcing:
 *   - Strict Content Security Policy (CSP) with no unsafe directives
 *   - Exact-match CORS allowlist (zero wildcards)
 *   - HTTP Strict Transport Security (HSTS) with preload eligibility
 *   - Full Helmet header suite (XSS, framing, MIME sniffing, referrer, etc.)
 *
 * Environment variables (all required in production):
 *   ALLOWED_ORIGINS   – Comma-separated list of exact origins, e.g.
 *                       "https://app.example.com,https://admin.example.com"
 *   CSP_REPORT_URI    – URI for CSP violation reports (optional but recommended)
 *   NODE_ENV          – "production" enables the strictest runtime guards
 */

import cors, { type CorsOptions } from "cors";
import helmet, { type HelmetOptions } from "helmet";
import type { Application, Request, Response, NextFunction } from "express";
import { maintenanceModeMiddleware } from "../middleware/maintenanceMode";

/**
 * Parse the ALLOWED_ORIGINS environment variable into a frozen Set of exact
 * origin strings.  Falls back to an empty set so that misconfigured deployments
 * block every cross-origin request rather than silently opening access.
 *
 * Each entry must be a fully-qualified origin (scheme + host + optional port):
 *   "https://app.example.com"          ✓
 *   "https://app.example.com:8443"     ✓
 *   "https://*.example.com"            ✗  wildcards are rejected at runtime
 */
function parseAllowedOrigins(): ReadonlySet<string> {
  const raw = process.env.ALLOWED_ORIGINS ?? "";

  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => {
      if (!o) return false;

      // Reject any entry that contains a wildcard — fail loudly so the
      // misconfiguration is caught at startup rather than silently skipped.
      if (o.includes("*")) {
        throw new Error(
          `[express.ts] Wildcard origins are not permitted. ` +
            `Remove "${o}" from ALLOWED_ORIGINS.`,
        );
      }

      // Reject non-HTTPS origins in production.
      if (process.env.NODE_ENV === "production" && !o.startsWith("https://")) {
        throw new Error(
          `[express.ts] Non-HTTPS origin "${o}" is not permitted in production.`,
        );
      }

      return true;
    });

  return Object.freeze(new Set(origins));
}

const ALLOWED_ORIGINS: ReadonlySet<string> = parseAllowedOrigins();

/**
 * Exact-match CORS configuration.
 *
 * Security properties:
 *   - Origin header is validated against an explicit allowlist on every request.
 *   - Requests from unlisted origins receive no CORS headers, causing the
 *     browser to block the response — a silent deny rather than an error.
 *   - No wildcard (`*`) is ever emitted in Access-Control-Allow-Origin.
 *   - Credentials are permitted only when the origin is explicitly listed,
 *     preventing cookie/auth-header leakage to third-party sites.
 *   - Preflight responses are cached for 10 minutes (600 s) to reduce latency
 *     without meaningfully expanding the attack surface.
 */
export const corsOptions: CorsOptions = {
  origin(
    requestOrigin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ): void {
    // Same-origin requests (e.g. server-to-server, curl) have no Origin header.
    // Allow them only in non-production environments; block in production to
    // avoid accidentally granting access to non-browser clients via CORS.
    if (!requestOrigin) {
      const allow = process.env.NODE_ENV !== "production";
      return callback(null, allow);
    }

    if (ALLOWED_ORIGINS.has(requestOrigin)) {
      return callback(null, true);
    }

    return callback(
      new Error(`[CORS] Origin "${requestOrigin}" is not in the allowlist.`),
    );
  },

  // Reflect the exact origin rather than echoing "*", which is required for
  // credentials (cookies, Authorization headers) to work correctly.
  credentials: true,

  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "X-Request-ID",
  ],

  exposedHeaders: [
    "X-Request-ID",
    "X-RateLimit-Limit",
    "X-RateLimit-Remaining",
  ],

  // Cache preflight responses for 10 minutes.
  maxAge: 600,

  // Respond to preflight OPTIONS requests automatically.
  optionsSuccessStatus: 204,
};

/**
 * Build the CSP directives object.
 *
 * Design goals:
 *   - No `unsafe-inline` or `unsafe-eval` anywhere.
 *   - No wildcard source expressions.
 *   - `default-src 'none'` as the fallback so unknown resource types are
 *     blocked by default.
 *   - `upgrade-insecure-requests` forces HTTP sub-resources to HTTPS.
 *   - `block-all-mixed-content` provides a belt-and-suspenders guard against
 *     mixed-content attacks alongside HSTS.
 *   - Violation reporting via `report-uri` / `report-to` so breaches are
 *     observable in production.
 *
 * Adjust the `scriptSrc`, `styleSrc`, and `connectSrc` arrays to match your
 * actual asset origins (CDN, analytics, etc.) rather than using wildcards.
 */
function buildCspDirectives(): Record<string, Iterable<string>> {
  const reportUri = process.env.CSP_REPORT_URI;

  // Origins from the allowlist are safe to include in connect-src so that
  // fetch/XHR to those APIs is permitted without additional manual maintenance.
  const allowedOriginList = Array.from(ALLOWED_ORIGINS);

  return {
    // Deny everything not explicitly permitted.
    defaultSrc: ["'none'"],

    // Scripts: only same-origin. Add your CDN here if needed, e.g.
    // "https://cdn.example.com" — never "'unsafe-inline'" or "'unsafe-eval'".
    scriptSrc: ["'self'"],

    // Styles: only same-origin.
    styleSrc: ["'self'"],

    // Images: same-origin + data URIs (needed for inline SVG/img src="data:…").
    imgSrc: ["'self'", "data:"],

    // Fonts: same-origin.
    fontSrc: ["'self'"],

    // fetch(), XHR, WebSocket: same-origin + explicitly listed API origins.
    connectSrc: ["'self'", ...allowedOriginList],

    // Iframes: deny.
    frameSrc: ["'none'"],

    // Web Workers / nested browsing contexts: deny.
    workerSrc: ["'none'"],

    // <object>, <embed>: deny.
    objectSrc: ["'none'"],

    // <base> tag: only same-origin (prevents base-tag hijacking).
    baseUri: ["'self'"],

    // Form submissions: only same-origin.
    formAction: ["'self'"],

    // Prevent this page being framed by anyone (belt-and-suspenders with X-Frame-Options).
    frameAncestors: ["'none'"],

    // Rewrite http:// sub-resource requests to https://.
    upgradeInsecureRequests: [],

    // Block mixed content even if upgrade-insecure-requests misses something.
    blockAllMixedContent: [],

    // CSP violation reporting.
    ...(reportUri
      ? {
          reportUri: [reportUri],
          reportTo: ["csp-endpoint"],
        }
      : {}),
  };
}

/**
 * Helmet configuration targeting Mozilla Observatory A+.
 *
 * Headers enforced:
 *   Content-Security-Policy          – strict, no unsafe directives
 *   Strict-Transport-Security        – 2-year max-age, includeSubDomains, preload
 *   X-Content-Type-Options           – nosniff
 *   X-Frame-Options                  – DENY
 *   X-XSS-Protection                 – disabled (modern browsers use CSP instead;
 *                                       leaving XSS auditor on can introduce bugs)
 *   Referrer-Policy                  – strict-origin-when-cross-origin
 *   Cross-Origin-Opener-Policy       – same-origin
 *   Cross-Origin-Resource-Policy     – same-origin
 *   Cross-Origin-Embedder-Policy     – require-corp
 *   Origin-Agent-Cluster             – ?1
 */
export const helmetOptions: HelmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false, // Start from scratch; no Helmet defaults bleed through.
    directives: buildCspDirectives(),
  },

  // max-age=63072000 = 2 years (minimum for HSTS preload submission).
  // includeSubDomains covers all subdomains.
  // preload opts the domain into browser preload lists.
  strictTransportSecurity: {
    maxAge: 63_072_000,
    includeSubDomains: true,
    preload: true,
  },

  xContentTypeOptions: true,

  // DENY is stricter than SAMEORIGIN; frameAncestors: ["'none'"] in CSP
  // provides the same protection for CSP-aware browsers.
  xFrameOptions: { action: "deny" },

  // Explicitly disabled: the legacy XSS auditor is off-by-default in modern
  // browsers and can introduce reflected-XSS vectors of its own.  CSP covers
  // this use-case correctly.
  xXssProtection: false,

  // Sends the full URL on same-origin navigations; only the origin on
  // cross-origin navigations; nothing on downgrades (HTTPS → HTTP).
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },

  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" },
  crossOriginEmbedderPolicy: { policy: "require-corp" },

  originAgentCluster: true,

  // Disable X-Powered-By
  hidePoweredBy: true,

  dnsPrefetchControl: { allow: false },
};

/**
 * Standalone middleware that writes the Permissions-Policy response header.
 *
 * Helmet v7 removed permissionsPolicy from HelmetOptions, so this header must
 * be set manually. Every sensitive browser API is denied by default; fullscreen
 * is restricted to same-origin only. Add entries to the array below if your
 * application legitimately requires any of these features.
 *
 * Reference: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy
 */
export function permissionsPolicyMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader(
    "Permissions-Policy",
    [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "bluetooth=()",
      "accelerometer=()",
      "gyroscope=()",
      "magnetometer=()",
      "ambient-light-sensor=()",
      "display-capture=()",
      "picture-in-picture=()",
      "fullscreen=(self)",
    ].join(", "),
  );
  next();
}

/**
 * Middleware that sets the `Report-To` header required by the CSP `report-to`
 * directive.  Only attached when CSP_REPORT_URI is configured.
 */
export function reportToMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const reportUri = process.env.CSP_REPORT_URI;
  if (reportUri) {
    res.setHeader(
      "Report-To",
      JSON.stringify({
        group: "csp-endpoint",
        max_age: 10886400,
        endpoints: [{ url: reportUri }],
        include_subdomains: true,
      }),
    );
  }
  next();
}

/**
 * Apply all security middleware to an Express application instance.
 *
 * Call this as early as possible in your middleware chain, before any route
 * handlers, so that every response carries the correct security headers.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { applySecurityMiddleware } from "./config/express";
 *
 * const app = express();
 * applySecurityMiddleware(app);
 *
 * app.get("/", (req, res) => res.json({ ok: true }));
 * ```
 */
export function applySecurityMiddleware(app: Application): void {
  // 1. Helmet (sets most security headers in one shot).
  app.use(helmet(helmetOptions));

  // 2. Permissions-Policy (not part of HelmetOptions in v7; set manually).
  app.use(permissionsPolicyMiddleware);

  // 3. Report-To (supplements the CSP report-to directive).
  app.use(reportToMiddleware);

  // 4. CORS (exact-match allowlist, no wildcards).
  app.use(cors(corsOptions));

  // 5. Maintenance Mode (blocks non-GET requests when active)
  app.use(maintenanceModeMiddleware);

  // 6. Respond to all OPTIONS preflight requests immediately.
  app.options("*", cors(corsOptions));
}
