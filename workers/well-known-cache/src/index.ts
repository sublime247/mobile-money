/// <reference types="@cloudflare/workers-types" />

interface Env {
  STELLAR_TOML_MAX_AGE: string;
  STELLAR_TOML_STALE_WHILE_REVALIDATE: string;
  DEFAULT_MAX_AGE: string;
  DEFAULT_STALE_WHILE_REVALIDATE: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface ErrorResponse {
  status: number;
  error: string;
  message: string;
  timestamp: string;
}

function errorResponse(status: number, error: string, message: string): Response {
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
      ...CORS_HEADERS,
    },
  });
}

function cacheControlFor(pathname: string): string {
  return pathname.endsWith("/stellar.toml")
    ? "public, max-age=3600, stale-while-revalidate=86400"
    : "public, max-age=300, stale-while-revalidate=3600";
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
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return errorResponse(
        405,
        "Method Not Allowed",
        `HTTP method ${request.method} is not supported. Use GET or HEAD.`
      );
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, "Bad Request", "Invalid request URL.");
    }

    try {
      const cache = caches.default;

      const cached = await cache.match(request);
      if (cached) {
        const res = new Response(cached.body, cached);
        res.headers.set("cf-cache-status", "HIT");
        for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
        return res;
      }

      const origin = await fetch(request);
      if (!origin.ok) {
        return errorResponse(
          origin.status,
          origin.statusText || "Upstream Error",
          `Origin server returned ${origin.status} for ${url.pathname}.`
        );
      }

      const res = new Response(origin.body, origin);
      res.headers.set("Cache-Control", cacheControlFor(url.pathname));
      res.headers.set("cf-cache-status", "MISS");
      for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);

      await cache.put(request, res.clone());
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred.";
      return errorResponse(502, "Bad Gateway", `Failed to fetch origin: ${message}`);
    }
  },
} satisfies ExportedHandler<Env>;
