/**
 * IP Reputation Service — issue #2465
 *
 * Tracks failed authentication and validation attempts per client IP in Redis
 * using a sliding-window counter.  When failures exceed a configurable
 * threshold within the window the IP is blocked automatically for 30 minutes.
 *
 * Redis key schema:
 *   ip:fail:<ip>        — sliding-window failure counter (TTL = window)
 *   ip:block:<ip>       — block marker (TTL = block duration)
 *
 * Admin API helpers allow inspection and manual removal of blocked IPs.
 */

import logger from "../utils/logger.js";
import { redisClient } from "../config/redis.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Number of failures within WINDOW_SECONDS before an IP is blocked. */
const FAILURE_THRESHOLD = parseInt(
  process.env.IP_REP_FAILURE_THRESHOLD ?? "20",
  10,
);

/** Sliding window length in seconds during which failures are counted. */
const WINDOW_SECONDS = parseInt(
  process.env.IP_REP_WINDOW_SECONDS ?? "300", // 5 minutes
  10,
);

/** How long a blocked IP stays blocked (seconds). */
const BLOCK_DURATION_SECONDS = parseInt(
  process.env.IP_REP_BLOCK_DURATION_SECONDS ?? "1800", // 30 minutes
  10,
);

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

function failKey(ip: string): string {
  return `ip:fail:${ip}`;
}

function blockKey(ip: string): string {
  return `ip:block:${ip}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IpReputationStatus {
  ip: string;
  isBlocked: boolean;
  failureCount: number;
  /** Remaining seconds until the block is lifted. null if not blocked. */
  blockTtlSeconds: number | null;
  /** Remaining seconds on the failure-count window. null if no failures. */
  windowTtlSeconds: number | null;
}

export interface IpReputationResult {
  blocked: boolean;
  justBlocked: boolean;
  failureCount: number;
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function isRedisReady(): boolean {
  return redisClient.isOpen;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record one failure for `ip`.
 *
 * Returns `{ blocked: true, justBlocked: true }` on the increment that
 * crosses the threshold, `{ blocked: true, justBlocked: false }` if the IP
 * was already blocked, and `{ blocked: false }` otherwise.
 */
export async function recordFailure(ip: string): Promise<IpReputationResult> {
  if (!isRedisReady()) {
    return { blocked: false, justBlocked: false, failureCount: 0 };
  }

  // Fast-path: already blocked
  const blockTtl = await redisClient.ttl(blockKey(ip));
  if (blockTtl > 0) {
    return { blocked: true, justBlocked: false, failureCount: FAILURE_THRESHOLD };
  }

  try {
    const count = await redisClient.incr(failKey(ip));

    // Set sliding-window TTL on first increment
    if (count === 1) {
      await redisClient.expire(failKey(ip), WINDOW_SECONDS);
    }

    if (count >= FAILURE_THRESHOLD) {
      // Write block key; NX prevents overwriting an existing block from a
      // concurrent request racing us here.
      const wasSet = await redisClient.set(blockKey(ip), "1", {
        EX: BLOCK_DURATION_SECONDS,
        NX: true,
      });

      // Clear the counter — the block key is now authoritative
      await redisClient.del(failKey(ip));

      if (wasSet) {
        logger.warn(
          { ip, count, blockDurationSeconds: BLOCK_DURATION_SECONDS },
          "[ipReputation] IP blocked after threshold breach",
        );
        return { blocked: true, justBlocked: true, failureCount: count };
      }

      return { blocked: true, justBlocked: false, failureCount: count };
    }

    return { blocked: false, justBlocked: false, failureCount: count };
  } catch (err) {
    logger.error({ ip, err }, "[ipReputation] recordFailure Redis error");
    return { blocked: false, justBlocked: false, failureCount: 0 };
  }
}

/**
 * Returns whether `ip` is currently blocked.
 */
export async function isIpBlocked(ip: string): Promise<boolean> {
  if (!isRedisReady()) return false;
  try {
    const ttl = await redisClient.ttl(blockKey(ip));
    return ttl > 0;
  } catch {
    return false;
  }
}

/**
 * Full status report for an IP — useful for the admin API.
 */
export async function getIpStatus(ip: string): Promise<IpReputationStatus> {
  if (!isRedisReady()) {
    return {
      ip,
      isBlocked: false,
      failureCount: 0,
      blockTtlSeconds: null,
      windowTtlSeconds: null,
    };
  }

  try {
    const [blockTtl, raw, windowTtl] = await Promise.all([
      redisClient.ttl(blockKey(ip)),
      redisClient.get(failKey(ip)),
      redisClient.ttl(failKey(ip)),
    ]);

    const isBlocked = blockTtl > 0;
    const failureCount = raw ? parseInt(String(raw), 10) : 0;

    return {
      ip,
      isBlocked,
      failureCount: isBlocked ? FAILURE_THRESHOLD : failureCount,
      blockTtlSeconds: isBlocked ? blockTtl : null,
      windowTtlSeconds: windowTtl > 0 ? windowTtl : null,
    };
  } catch (err) {
    logger.error({ ip, err }, "[ipReputation] getIpStatus Redis error");
    return {
      ip,
      isBlocked: false,
      failureCount: 0,
      blockTtlSeconds: null,
      windowTtlSeconds: null,
    };
  }
}

/**
 * Admin: manually remove a block and clear the failure counter for an IP.
 * Returns `true` if a block was removed.
 */
export async function adminUnblockIp(ip: string): Promise<boolean> {
  if (!isRedisReady()) return false;
  try {
    const deleted = await redisClient.del([blockKey(ip), failKey(ip)]);
    const removed = (deleted as unknown as number) > 0;
    if (removed) {
      logger.info({ ip }, "[ipReputation] IP manually unblocked by admin");
    }
    return removed;
  } catch (err) {
    logger.error({ ip, err }, "[ipReputation] adminUnblockIp Redis error");
    return false;
  }
}

/**
 * Admin: list all currently blocked IPs by scanning Redis for block keys.
 * Returns array of `{ ip, ttlSeconds }` objects.
 */
export async function listBlockedIps(): Promise<
  Array<{ ip: string; ttlSeconds: number }>
> {
  if (!isRedisReady()) return [];

  const blocked: Array<{ ip: string; ttlSeconds: number }> = [];
  let cursor = "0";

  try {
    do {
      const reply = await redisClient.scan(cursor, {
        MATCH: "ip:block:*",
        COUNT: 100,
      });
      cursor = String(reply.cursor);

      for (const key of reply.keys) {
        const ip = key.replace("ip:block:", "");
        const ttl = await redisClient.ttl(key);
        if (ttl > 0) blocked.push({ ip, ttlSeconds: ttl });
      }
    } while (cursor !== "0");
  } catch (err) {
    logger.error({ err }, "[ipReputation] listBlockedIps Redis error");
  }

  return blocked;
}

// ---------------------------------------------------------------------------
// Express middleware helper
// ---------------------------------------------------------------------------

/**
 * Returns the client IP from an Express request, respecting X-Forwarded-For
 * when the app is behind a trusted proxy.
 */
export function extractClientIp(req: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return first.trim();
  }
  return req.ip ?? "unknown";
}
import { LocationMetadata } from "./geolocation";

export interface IPRiskResult {
  isTorExitNode: boolean;
  isProxy: boolean;
  highRiskJurisdiction: boolean;
  countryCode: string;
  riskScore: number;
}

export class IPReputationService {
  async checkIP(ip: string): Promise<IPRiskResult> {
    // Mock MaxMind / ProxyCheck logic for local testing
    const isTorExitNode = ip === "185.220.101.1" || ip === "192.42.116.16"; // example mock IPs
    const isProxy = ip.startsWith("104.28."); // example proxy
    const countryCode = "US"; // Default mock country
    const highRiskJurisdiction = ["KP", "IR", "SY"].includes(countryCode);
    
    let riskScore = 0;
    if (isTorExitNode) riskScore += 90;
    if (isProxy) riskScore += 50;
    if (highRiskJurisdiction) riskScore += 100;
    
    return {
      isTorExitNode,
      isProxy,
      highRiskJurisdiction,
      countryCode,
      riskScore: Math.min(riskScore, 100)
    };
  }
}

export const ipReputationService = new IPReputationService();
