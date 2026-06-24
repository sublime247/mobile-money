/// <reference types="@cloudflare/workers-types" />

interface Env {
  STELLAR_TOML_MAX_AGE: string;
  STELLAR_TOML_STALE_WHILE_REVALIDATE: string;
  DEFAULT_MAX_AGE: string;
  DEFAULT_STALE_WHILE_REVALIDATE: string;
  DR_FAILOVER_URL?: string;
  DR_FAILOVER_MODE?: "PROXY" | "REDIRECT";
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
  failoverActive?: boolean;
  failoverMode?: "PROXY" | "REDIRECT";
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
    const startTime = Date.now();
    let cacheStatus: "HIT" | "MISS" | "BYPASS" = "BYPASS";
    let failoverActive = false;
    let failoverMode: "PROXY" | "REDIRECT" | undefined;

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

    const getMetrics = (res: Response): RequestMetrics => ({
      method: request.method,
      pathname: url.pathname,
      cacheStatus,
      statusCode: res.status,
      latencyMs: Date.now() - startTime,
      responseBytes: Number(res.headers.get("content-length") || 0),
      timestamp: new Date().toISOString(),
      userAgent: request.headers.get("user-agent") || "",
      ...(failoverActive ? { failoverActive, failoverMode } : {}),
    });

    try {
      const cache = caches.default;

      const cached = await cache.match(request);
      if (cached) {
        const res = new Response(cached.body, cached);
        res.headers.set("cf-cache-status", "HIT");
        for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
        cacheStatus = "HIT";
        logMetrics(getMetrics(res));
        return res;
      }

      let origin: Response | null = null;
      let originError: Error | null = null;
      let isBackendDrop = false;

      try {
        origin = await fetch(request);
        if (!origin.ok && origin.status >= 500) {
          isBackendDrop = true;
        }
      } catch (err) {
        originError = err instanceof Error ? err : new Error(String(err));
        isBackendDrop = true;
      }

      if (isBackendDrop && env.DR_FAILOVER_URL) {
        failoverActive = true;
        failoverMode = env.DR_FAILOVER_MODE || "PROXY";
        const drUrl = new URL(url.pathname + url.search, env.DR_FAILOVER_URL);

        console.warn(`DR Failover active: routing to ${drUrl.toString()} using mode ${failoverMode}`);

        if (failoverMode === "REDIRECT") {
          const res = Response.redirect(drUrl.toString(), 307);
          logMetrics(getMetrics(res));
          return res;
        } else {
          // PROXY mode
          try {
            const drRequest = new Request(drUrl.toString(), request);
            const drOrigin = await fetch(drRequest);

            if (drOrigin.ok) {
              const res = new Response(drOrigin.body, drOrigin);
              res.headers.set("Cache-Control", cacheControlFor(url.pathname));
              res.headers.set("cf-cache-status", "MISS");
              res.headers.set("x-dr-failover", "true");
              for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);

              cacheStatus = "MISS";
              await cache.put(request, res.clone());
              logMetrics(getMetrics(res));
              return res;
            } else {
              const res = errorResponse(
                drOrigin.status,
                drOrigin.statusText || "DR Upstream Error",
                `Disaster Recovery server returned ${drOrigin.status} for ${url.pathname}.`
              );
              logMetrics(getMetrics(res));
              return res;
            }
          } catch (drErr) {
            const drMessage = drErr instanceof Error ? drErr.message : "An unexpected error occurred.";
            const res = errorResponse(502, "Bad Gateway", `Failed to fetch Disaster Recovery server: ${drMessage}`);
            logMetrics(getMetrics(res));
            return res;
          }
        }
      }

      // No failover or primary request succeeded
      if (isBackendDrop) {
        // No DR_FAILOVER_URL configured, return the primary error
        const res = origin
          ? errorResponse(
              origin.status,
              origin.statusText || "Upstream Error",
              `Origin server returned ${origin.status} for ${url.pathname}.`
            )
          : errorResponse(502, "Bad Gateway", `Failed to fetch origin: ${originError?.message}`);
        logMetrics(getMetrics(res));
        return res;
      }

      // Safe to assert origin is non-null since isBackendDrop is false
      const primaryRes = origin!;
      if (!primaryRes.ok) {
        // Primary returned a 4xx status code
        const res = errorResponse(
          primaryRes.status,
          primaryRes.statusText || "Upstream Error",
          `Origin server returned ${primaryRes.status} for ${primaryRes.status >= 400 ? url.pathname : ""}.`
        );
        logMetrics(getMetrics(res));
        return res;
      }

      const res = new Response(primaryRes.body, primaryRes);
      res.headers.set("Cache-Control", cacheControlFor(url.pathname));
      res.headers.set("cf-cache-status", "MISS");
      for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);

      cacheStatus = "MISS";
      await cache.put(request, res.clone());
      logMetrics(getMetrics(res));
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred.";
      const res = errorResponse(502, "Bad Gateway", `Failed to fetch origin: ${message}`);
      logMetrics(getMetrics(res));
      return res;
    }
  },
} satisfies ExportedHandler<Env>;
