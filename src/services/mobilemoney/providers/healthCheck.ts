import { createClient, RedisClientType } from "redis";
import { healthCheckResponseTimeSeconds } from "../../../utils/metrics";

// ─── Public types ─────────────────────────────────────────────────────────────

export type ProviderName = "mtn" | "airtel" | "orange";
export type ProviderStatus = "up" | "down";

export interface ProviderHealth {
  status: ProviderStatus;
  /** Wall-clock milliseconds for the ping round-trip.
   *  null when the request never completed (network error / timeout). */
  responseTime: number | null;
}

export interface MobileMoneyHealthResult {
  providers: Record<ProviderName, ProviderHealth>;
}

// ─── Provider configuration ───────────────────────────────────────────────────

export interface ProviderConfig {
  name: ProviderName;
  /**
   * A lightweight endpoint to HEAD/GET.
   * Prefer a /ping or /status path; an auth endpoint is an acceptable fallback
   * since it returns a fast 4xx without executing business logic.
   */
  pingUrl: string;
  /** Abort the request after this many ms and treat the provider as "down". */
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = Number(
  process.env.PROVIDER_HEALTH_TIMEOUT_MS ?? 5_000,
);

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    name: "mtn",
    pingUrl:
      process.env.MTN_HEALTH_URL ??
      "https://sandbox.momodeveloper.mtn.com/v1_0/apiuser",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  },
  {
    name: "airtel",
    pingUrl:
      process.env.AIRTEL_HEALTH_URL ??
      "https://openapi.airtel.africa/auth/oauth2/token",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  },
  {
    name: "orange",
    pingUrl:
      process.env.ORANGE_HEALTH_URL ??
      "https://api.orange.com/orange-money-webpay/dev/v1/webpayment",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  },
];

// ─── Structured logger ────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";

function log(
  level: LogLevel,
  message: string,
  meta: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "mobilemoney-health",
    message,
    ...meta,
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ─── Cache (Redis + in-process fallback) ──────────────────────────────────────

const CACHE_KEY = "mobilemoney:health";
const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

/** Lazily initialised Redis client — reuses the project's REDIS_URL. */
let redisClient: RedisClientType | null = null;

async function getRedisClient(): Promise<RedisClientType | null> {
  if (redisClient) return redisClient;
  if (!process.env.REDIS_URL) return null;

  try {
    const client = createClient({
      url: process.env.REDIS_URL,
    }) as RedisClientType;
    await client.connect();
    redisClient = client;
    return redisClient;
  } catch (err) {
    log("warn", "Redis unavailable — using in-process cache", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** In-process fallback (single-node only; fine for dev / small deployments). */
export const _inProcessCache: {
  result: MobileMoneyHealthResult | null;
  expiresAt: number;
} = { result: null, expiresAt: 0 };

async function getCached(): Promise<MobileMoneyHealthResult | null> {
  const client = await getRedisClient();
  if (client) {
    try {
      const raw = await client.get(CACHE_KEY);
      if (raw) return JSON.parse(raw) as MobileMoneyHealthResult;
    } catch {
      /* Redis read error → fall through to in-process */
    }
  }
  if (_inProcessCache.result && Date.now() < _inProcessCache.expiresAt) {
    return _inProcessCache.result;
  }
  return null;
}

async function setCached(result: MobileMoneyHealthResult): Promise<void> {
  const client = await getRedisClient();
  if (client) {
    try {
      await client.set(CACHE_KEY, JSON.stringify(result), {
        EX: CACHE_TTL_SECONDS,
      });
      return;
    } catch {
      /* Redis write error → fall through */
    }
  }
  _inProcessCache.result = result;
  _inProcessCache.expiresAt = Date.now() + CACHE_TTL_SECONDS * 1_000;
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

/** Open circuit after this many consecutive failures. */
const FAILURE_THRESHOLD = 3;
/** Keep circuit open for this many ms before allowing a retry. */
const OPEN_DURATION_MS = 60_000;

interface CircuitState {
  failures: number;
  openUntil: number; // epoch ms; 0 = closed
}

export const _circuitMap = new Map<string, CircuitState>();

function getCircuit(provider: string): CircuitState {
  if (!_circuitMap.has(provider)) {
    _circuitMap.set(provider, { failures: 0, openUntil: 0 });
  }
  return _circuitMap.get(provider)!;
}

/**
 * Returns true while the circuit is open.
 * Transitions open → half-open automatically once OPEN_DURATION_MS elapses.
 */
function isCircuitOpen(provider: string): boolean {
  const state = getCircuit(provider);
  if (state.openUntil > Date.now()) return true;
  if (state.openUntil !== 0) {
    // Half-open: reset and let one probe through
    state.failures = 0;
    state.openUntil = 0;
  }
  return false;
}

function recordSuccess(provider: string): void {
  const state = getCircuit(provider);
  state.failures = 0;
  state.openUntil = 0;
}

function recordFailure(provider: string): void {
  const state = getCircuit(provider);
  state.failures += 1;
  if (state.failures >= FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + OPEN_DURATION_MS;
    log("warn", "Circuit opened for provider", {
      provider,
      openUntil: new Date(state.openUntil).toISOString(),
      failures: state.failures,
    });
  }
}

// ─── Core ping ────────────────────────────────────────────────────────────────

/**
 * Pings one provider endpoint and returns its health.
 *
 * Status mapping:
 *   HTTP < 500  → "up"   (the API gateway / auth server is reachable)
 *   HTTP 5xx    → "down" (server error on the provider's side)
 *   Network err → "down", responseTime: null
 *   Timeout     → "down", responseTime: null
 *
 * Exported so individual provider checks can be unit-tested in isolation.
 */
export async function pingProvider(
  config: ProviderConfig,
  fetchFn: typeof fetch = fetch,
): Promise<ProviderHealth> {
  const { name, pingUrl, timeoutMs } = config;

  if (isCircuitOpen(name)) {
    log("warn", "Circuit open — skipping ping", { provider: name });
    return { status: "down", responseTime: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetchFn(pingUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);

    const responseTime = Date.now() - start;

    if (response.status < 500) {
      recordSuccess(name);
      healthCheckResponseTimeSeconds.observe(
        { provider: name, status: "up" },
        responseTime / 1000,
      );
      log("info", "Provider ping succeeded", {
        provider: name,
        httpStatus: response.status,
        responseTime,
      });
      return { status: "up", responseTime };
    }

    recordFailure(name);
    healthCheckResponseTimeSeconds.observe(
      { provider: name, status: "down" },
      responseTime / 1000,
    );
    log("error", "Provider returned server error", {
      provider: name,
      httpStatus: response.status,
      responseTime,
    });
    return { status: "down", responseTime };
  } catch (err) {
    clearTimeout(timer);
    recordFailure(name);

    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" ||
        err.message.toLowerCase().includes("abort"));

    log("error", "Provider ping failed", {
      provider: name,
      reason: isAbort
        ? "timeout"
        : err instanceof Error
          ? err.message
          : String(err),
    });

    healthCheckResponseTimeSeconds.observe(
      { provider: name, status: "error" },
      (Date.now() - start) / 1000,
    );
    return { status: "down", responseTime: null };
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Returns the aggregated health status of all mobile money providers.
 *
 * Suitable for inclusion in GET /health — it never rejects.
 *
 * @param providers  Override the default list (useful in tests).
 * @param fetchFn    Override the fetch implementation (useful in tests).
 */
export async function checkMobileMoneyHealth(
  providers: ProviderConfig[] = DEFAULT_PROVIDERS,
  fetchFn: typeof fetch = fetch,
): Promise<MobileMoneyHealthResult> {
  const cached = await getCached();
  if (cached) {
    log("info", "Returning cached mobile money health");
    return cached;
  }

  // Ping concurrently so a slow provider doesn't delay the others
  const results = await Promise.all(
    providers.map((p) => pingProvider(p, fetchFn)),
  );

  const providersMap = {} as Record<ProviderName, ProviderHealth>;
  providers.forEach((p, i) => {
    providersMap[p.name] = results[i];
    if (results[i].status === "down") {
      log("error", "Provider outage detected", {
        provider: p.name,
        responseTime: results[i].responseTime,
      });
    }
  });

  const result: MobileMoneyHealthResult = { providers: providersMap };
  await setCached(result);
  return result;
}

// ─── Test-only helpers ────────────────────────────────────────────────────────
// Prefixed with _ to signal they are not part of the public API.

/** Clears the in-process cache.  Call in beforeEach. */
export function _clearCache(): void {
  _inProcessCache.result = null;
  _inProcessCache.expiresAt = 0;
}

/** Resets all circuit-breaker state.  Call in beforeEach. */
export function _resetCircuits(): void {
  _circuitMap.clear();
}
