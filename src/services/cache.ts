import { Request, Response, NextFunction } from "express";
import { redisClient } from "../config/redis";
import {
  cacheHitsTotal,
  cacheMissesTotal,
  cacheHitRatio,
} from "../utils/metrics";

export type CacheOptions = {
  // TTL in seconds or function(req) => number
  ttl?: number | ((req: Request) => number);
  // Key string or function(req) => string
  key?: string | ((req: Request) => string);
  // If true, only cache GET requests (default true)
  onlyGet?: boolean;
  // Prefix for keys
  prefix?: string;
};

const DEFAULT_PREFIX = "cache:";

/**
 * Usage examples:
 *
 * - Decorate a controller method to cache responses (transparent):
 *   @Cache()
 *   static async getStats(req, res) { ... }
 *
 * - Provide custom TTL or key:
 *   @Cache({ ttl: (req) => req.query.refresh ? 5 : 900, key: (req) => `stats:full:${req.query.startDate || 'all'}` })
 *
 * - Invalidate when underlying data changes:
 *   import { invalidatePattern } from "../services/cache";
 *   // after creating/updating related resources
 *   await invalidatePattern("cache:/api/stats*");
 */

function defaultKey(req: Request) {
  // Use path + sorted query string to form stable key
  const url = req.path;
  const params = Object.keys(req.query)
    .sort()
    .map((k) => `${k}=${String(req.query[k])}`)
    .join("&");
  return `${url}${params ? `?${params}` : ""}`;
}

function getTTL(opts?: CacheOptions, req?: Request) {
  if (!opts) return 60 * 15; // default 15 minutes
  if (typeof opts.ttl === "number") return opts.ttl;
  if (typeof opts.ttl === "function" && req) return opts.ttl(req);
  // Heuristic: requests with query params are more specific => shorter TTL
  if (req && Object.keys(req.query).length > 0) return 60; // 1 minute
  return 60 * 15; // 15 minutes
}

async function getFromCache(fullKey: string) {
  if (!redisClient || !redisClient.isOpen) return null;
  try {
    const raw = await redisClient.get(fullKey);
    if (!raw) return null;
    const rawStr = typeof raw === 'string' ? raw : raw.toString();
    return JSON.parse(rawStr);
  } catch (err) {
    // Swallow cache errors; caching is a best-effort optimisation
    console.warn("Cache: get error", err);
    return null;
  }
}

async function setToCache(fullKey: string, ttlSec: number, value: unknown) {
  if (!redisClient || !redisClient.isOpen) return;
  try {
    await redisClient.setEx(fullKey, ttlSec, JSON.stringify(value));
  } catch (err) {
    console.warn("Cache: set error", err);
  }
}

export async function invalidateCache(key: string) {
  if (!redisClient || !redisClient.isOpen) return 0;
  try {
    return await redisClient.del(key);
  } catch (err) {
    console.warn("Cache: invalidate error", err);
    return 0;
  }
}

export async function invalidatePattern(pattern: string) {
  if (!redisClient || !redisClient.isOpen) return 0;
  try {
    const keys = await redisClient.keys(pattern);
    if (!keys || keys.length === 0) return 0;
    return await redisClient.del(keys);
  } catch (err) {
    console.warn("Cache: invalidatePattern error", err);
    return 0;
  }
}

// Helper to update cache hit ratio gauge for a given route
// Local counts to avoid async .get() complexities from prom-client; we maintain small in-memory counters
const localCacheCounts = new Map<string, { hits: number; misses: number }>();

function updateHitRatio(route: string, hit: boolean) {
  try {
    const labels = { route };
    if (!localCacheCounts.has(route)) {
      localCacheCounts.set(route, { hits: 0, misses: 0 });
    }
    const entry = localCacheCounts.get(route)!;
    if (hit) {
      entry.hits += 1;
      cacheHitsTotal.inc(labels);
    } else {
      entry.misses += 1;
      cacheMissesTotal.inc(labels);
    }

    const denom = entry.hits + entry.misses;
    const ratio = denom > 0 ? entry.hits / denom : 0;
    cacheHitRatio.set(labels, ratio);
  } catch (e) {
    console.warn("Cache: metrics update error", e);
  }
}

export function Cache(opts?: CacheOptions) {
  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    // In some transpilation/runtime paths decorators may be invoked without
    // a legacy property descriptor. In that case, skip wrapping to avoid
    // crashing application startup.
    if (!descriptor || typeof descriptor.value !== "function") {
      return descriptor;
    }

    const original = descriptor.value as (
      ...args: unknown[]
    ) => Promise<unknown> | unknown;

    descriptor.value = async function (
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      try {
        if (opts?.onlyGet === undefined && req.method !== "GET") {
          // allow caching only for GET by default
        }

        if (opts?.onlyGet && req.method !== "GET") {
          return original.apply(this, [req, res, next]);
        }

        const keyBase =
          typeof opts?.key === "string"
            ? opts!.key
            : typeof opts?.key === "function"
              ? (opts!.key as (r: Request) => string)(req)
              : defaultKey(req);

        const prefix = opts?.prefix ?? DEFAULT_PREFIX;
        const fullKey = `${prefix}${keyBase}`;

        // Try read from cache
        const cached = await getFromCache(fullKey);
        const routeLabel = req.route ? req.route.path : req.path;
        if (cached !== null) {
          updateHitRatio(routeLabel, true);
          // Serve cached response directly
          res.setHeader("X-Cache", "HIT");
          // If cached contains statusCode and body we try to restore; otherwise send JSON
          if (cached && typeof cached === "object" && cached.__rawResponse) {
            const { statusCode, body } = cached.__rawResponse;
            res.status(statusCode).json(body);
            return;
          }
          res.json(cached);
          return;
        }

        updateHitRatio(routeLabel, false);

        // Capture res.json to store value when the handler responds
        const originalJson = res.json.bind(res);
        res.json = function (body: unknown) {
          try {
            const responseWrapper = {
              __rawResponse: {
                statusCode: res.statusCode || 200,
                body,
              },
            };
            const ttl = getTTL(opts, req);
            // store cached response asynchronously (don't block response)
            void setToCache(fullKey, ttl, responseWrapper);
            res.setHeader("X-Cache", "MISS");
          } catch (err) {
            console.warn("Cache: res.json wrapper error", err);
          }
          return originalJson(body);
        } as typeof res.json;

        // Call original handler
        return await original.apply(this, [req, res, next]);
      } catch (err) {
        // On any decorator-level error, fall back to original handler
        console.warn("Cache decorator error", err);
        return original.apply(this, [req, res, next]);
      }
    };

    // keep a reference in case of fallback
    (descriptor.value as unknown as { original?: unknown }).original = original;

    return descriptor;
  } as MethodDecorator;
}

export default {
  Cache,
  invalidateCache,
  invalidatePattern,
};
