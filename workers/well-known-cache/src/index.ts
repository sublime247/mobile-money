/// <reference types="@cloudflare/workers-types" />

interface Env {
  STELLAR_TOML_MAX_AGE: string;
  STELLAR_TOML_STALE_WHILE_REVALIDATE: string;
  DEFAULT_MAX_AGE: string;
  DEFAULT_STALE_WHILE_REVALIDATE: string;
  /**
   * Comma-separated list of allowed origins for CORS.
   * Example: "https://app.example.com,https://admin.example.com"
   * When empty or unset, falls back to wildcard "*" for backward compatibility.
   */
  ALLOWED_ORIGINS: string;
}

interface ErrorResponse {
  status: number;
  error: string;
  message: string;
  timestamp: string;
}

interface RequestMetrics {
  method: string;
  pathname: string;
  cacheStatus: "HIT" | "MISS" | "BYPASS";
  statusCode: number;
  latencyMs: number;
  responseBytes: number;
  timestamp: string;
  userAgent: string;
}

/**
 * Parse the ALLOWED_ORIGINS environment variable into a Set of exact origin
 * strings. Returns an empty set when the variable is unset or empty.
 */
function parseAllowedOrigins(raw: string | undefined): Set<string> {
  if (!raw || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  );
}

/**
 * Build CORS headers for the given request origin.
 *
 * - When ALLOWED_ORIGINS is configured and the request Origin is in the
 *   allowlist, the specific origin is reflected back (credential-safe).
 * - When ALLOWED_ORIGINS is configured but the Origin is NOT in the list,
 *   no Access-Control-Allow-Origin header is emitted (browser blocks the
 *   response).
 * - When ALLOWED_ORIGINS is empty/unset, wildcard "*" is used for backward
 *   compatibility with the original behaviour.
 */
export function buildCorsHeaders(
  requestOrigin: string | null,
  allowedOrigins: Set<string>
): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (allowedOrigins.size === 0) {
    // No allowlist configured — wildcard (original behaviour)
    return { ...base, "Access-Control-Allow-Origin": "*" };
  }

  if (requestOrigin && allowedOrigins.has(requestOrigin)) {
    return {
      ...base,
      "Access-Control-Allow-Origin": requestOrigin,
      Vary: "Origin",
    };
  }

  // Origin not allowed — omit Access-Control-Allow-Origin
  return base;
}

function errorResponse(
  status: number,
  error: string,
  message: string,
  corsHeaders: Record<string, string>
): Response {
  const body: ErrorResponse = {
    status,
    error,
    message,
    timestamp: new Date().toISOString(),
  };
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

function cacheControlFor(pathname: string): string {
  return pathname.endsWith("/stellar.toml")
    ? "public, max-age=3600, stale-while-revalidate=86400"
    : "public, max-age=300, stale-while-revalidate=3600";
}

function logMetrics(metrics: RequestMetrics): void {
  console.log(
    JSON.stringify({
      level: "info",
      type: "edge_request_metrics",
      ...metrics,
    })
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const requestOrigin = request.headers.get("Origin");
    const corsHeaders = buildCorsHeaders(requestOrigin, allowedOrigins);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return errorResponse(
        405,
        "Method Not Allowed",
        `HTTP method ${request.method} is not supported. Use GET or HEAD.`,
        corsHeaders
      );
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, "Bad Request", "Invalid request URL.", corsHeaders);
    }

    try {
      const cache = caches.default;

      const cached = await cache.match(request);
      if (cached) {
        const res = new Response(cached.body, cached);
        res.headers.set("cf-cache-status", "HIT");
        for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
        return res;
      }

      const origin = await fetch(request);
      if (!origin.ok) {
        return errorResponse(
          origin.status,
          origin.statusText || "Upstream Error",
          `Origin server returned ${origin.status} for ${url.pathname}.`,
          corsHeaders
        );
      }

      const res = new Response(origin.body, origin);
      res.headers.set("Cache-Control", cacheControlFor(url.pathname));
      res.headers.set("cf-cache-status", "MISS");
      for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);

      await cache.put(request, res.clone());
      return res;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      return errorResponse(
        502,
        "Bad Gateway",
        `Failed to fetch origin: ${message}`,
        corsHeaders
      );
    }
  },
} satisfies ExportedHandler<Env>;
