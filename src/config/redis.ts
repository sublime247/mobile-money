import logger from "../utils/logger";
import { createClient } from "redis";
import RedisStore from "connect-redis";

export const SESSION_TTL_SECONDS = parseInt(
  process.env.SESSION_TTL_SECONDS || "86400",
);

type SentinelNode = {
  host: string;
  port: number;
};

const localFallbackCache: Array<{ key: string; value: string }> = [];
let isRedisClusterOffline = false;

function getLocalCache(key: string): string | null {
  const item = localFallbackCache.find((c) => c.key === key);
  return item ? item.value : null;
}

function setLocalCache(key: string, value: string): void {
  const item = localFallbackCache.find((c) => c.key === key);
  if (item) {
    item.value = value;
  } else {
    localFallbackCache.push({ key, value });
  }
}

function delLocalCache(key: string): void {
  const index = localFallbackCache.findIndex((c) => c.key === key);
  if (index !== -1) {
    localFallbackCache.splice(index, 1);
  }
}

const DEFAULT_REDIS_URL = "redis://localhost:6379";
const BASE_REDIS_URL = process.env.REDIS_URL || DEFAULT_REDIS_URL;
const SENTINEL_MASTER_NAME =
  process.env.REDIS_SENTINEL_MASTER_NAME || "mymaster";
const SENTINEL_USERNAME = process.env.REDIS_SENTINEL_USERNAME;
const SENTINEL_PASSWORD = process.env.REDIS_SENTINEL_PASSWORD;

const SENTINEL_NODES = parseSentinelNodes(process.env.REDIS_SENTINELS);
const SENTINEL_ENABLED = SENTINEL_NODES.length > 0;

/**
 * Loads Redis password/username from env and validates presence.
 * Production must have a password set; local/dev may omit it but gets a warning.
 */
function loadRedisAuthConfig(): { username?: string; password?: string } {
  const password = process.env.REDIS_PASSWORD?.trim();
  const username = process.env.REDIS_USERNAME?.trim();

  if (!password) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Redis: REDIS_PASSWORD is required in production but was not set.",
      );
    }
    logger.warn(
      "Redis: REDIS_PASSWORD is not set — connecting without authentication. Only acceptable for local development.",
    );
    return {};
  }

  return { password, ...(username ? { username } : {}) };
}

const REDIS_AUTH = loadRedisAuthConfig();

let activeRedisUrl = BASE_REDIS_URL;
let masterRefreshInFlight: Promise<boolean> | null = null;
let roleVerificationInFlight = false;
let failoverInFlight = false;
let sentinelSubscriber: ReturnType<typeof createClient> | null = null;

const redisClient = createClient({
  url: activeRedisUrl,
  ...REDIS_AUTH,
  socket: {
    reconnectStrategy: (retries, cause) => {
      if (SENTINEL_ENABLED) {
        void scheduleMasterRefresh("reconnect");
      }

      if (retries > 100) {
        logger.error("Redis: Max reconnection attempts reached", { cause });
        return new Error("Max reconnection attempts reached");
      }
      return Math.min(100 + retries * 200, 3000);
    },
  },
});

function parseSentinelNodes(raw?: string): SentinelNode[] {
  if (!raw) return [];

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, portRaw] = entry.split(":");
      const port = Number.parseInt(portRaw || "26379", 10);
      if (!host || Number.isNaN(port)) return null;
      return { host, port };
    })
    .filter((node): node is SentinelNode => node !== null);
}

function buildRedisUrl(host: string, port: number): string {
  const parsed = new URL(BASE_REDIS_URL);
  parsed.hostname = host;
  parsed.port = String(port);
  return parsed.toString();
}

async function resolveMasterFromSentinel(): Promise<SentinelNode | null> {
  for (const node of SENTINEL_NODES) {
    const sentinelClient = createClient({
      socket: {
        host: node.host,
        port: node.port,
        reconnectStrategy: () => false,
      },
      username: SENTINEL_USERNAME,
      password: SENTINEL_PASSWORD,
    });

    try {
      await sentinelClient.connect();
      const response = (await sentinelClient.sendCommand([
        "SENTINEL",
        "get-master-addr-by-name",
        SENTINEL_MASTER_NAME,
      ])) as unknown;

      if (Array.isArray(response) && response.length >= 2) {
        const [host, portRaw] = response as [string, string];
        const port = Number.parseInt(portRaw, 10);
        if (host && !Number.isNaN(port)) {
          return { host, port };
        }
      }
    } catch (error) {
      console.warn("Redis Sentinel: failed to query node", {
        node: `${node.host}:${node.port}`,
        error,
      });
    } finally {
      try {
        if (sentinelClient.isOpen) {
          await sentinelClient.quit();
        }
      } catch {
        sentinelClient.disconnect();
      }
    }
  }

  return null;
}

async function refreshMasterEndpoint(
  reason: string,
  reconnectIfChanged: boolean,
): Promise<boolean> {
  if (!SENTINEL_ENABLED) return false;

  const master = await resolveMasterFromSentinel();
  if (!master) {
    console.warn("Redis Sentinel: could not resolve master", { reason });
    return false;
  }

  const nextUrl = buildRedisUrl(master.host, master.port);
  if (nextUrl === activeRedisUrl) return false;

  const previousUrl = activeRedisUrl;
  activeRedisUrl = nextUrl;
  (redisClient as any).options.url = nextUrl;

  console.warn("Redis Sentinel: updated master endpoint", {
    reason,
    previousUrl,
    nextUrl,
  });

  if (reconnectIfChanged && redisClient.isOpen) {
    try {
      redisClient.disconnect();
      await redisClient.connect();
    } catch (error) {
      logger.error(
        "Redis: reconnect after master endpoint update failed",
        error,
      );
    }
  }

  return true;
}

function scheduleMasterRefresh(reason: string): Promise<boolean> {
  if (masterRefreshInFlight) return masterRefreshInFlight;
  masterRefreshInFlight = refreshMasterEndpoint(reason, false).finally(() => {
    masterRefreshInFlight = null;
  });
  return masterRefreshInFlight;
}

async function verifyConnectedNodeRole(): Promise<void> {
  if (!SENTINEL_ENABLED || !redisClient.isOpen || roleVerificationInFlight)
    return;
  roleVerificationInFlight = true;
  try {
    const roleResponse = (await redisClient.sendCommand(["ROLE"])) as unknown;
    if (!Array.isArray(roleResponse) || roleResponse.length === 0) return;

    const role = String(roleResponse[0] || "").toLowerCase();
    if (role !== "master") {
      console.warn(
        "Redis: connected node is not master; forcing failover reconnect",
        {
          role,
        },
      );
      await forceFailoverReconnect(`role:${role}`);
    }
  } catch (error) {
    console.warn("Redis: failed to verify node role", error);
  } finally {
    roleVerificationInFlight = false;
  }
}

async function forceFailoverReconnect(reason: string): Promise<void> {
  if (!SENTINEL_ENABLED || failoverInFlight) return;
  failoverInFlight = true;
  try {
    await refreshMasterEndpoint(reason, true);
  } finally {
    failoverInFlight = false;
  }
}

async function setupSentinelSwitchMasterListener(): Promise<void> {
  if (!SENTINEL_ENABLED || sentinelSubscriber) return;

  for (const node of SENTINEL_NODES) {
    const client = createClient({
      socket: {
        host: node.host,
        port: node.port,
        reconnectStrategy: (retries) => Math.min(100 + retries * 200, 2000),
      },
      username: SENTINEL_USERNAME,
      password: SENTINEL_PASSWORD,
    });

    try {
      await client.connect();
      await client.subscribe("+switch-master", async (message) => {
        console.warn("Redis Sentinel: +switch-master received", { message });
        await forceFailoverReconnect("sentinel:+switch-master");
      });
      sentinelSubscriber = client;
      console.log(
        `Redis Sentinel: listening for failover events on ${node.host}:${node.port}`,
      );
      return;
    } catch (error) {
      console.warn("Redis Sentinel: failed to subscribe on node", {
        node: `${node.host}:${node.port}`,
        error,
      });
      try {
        if (client.isOpen) {
          await client.quit();
        }
      } catch {
        client.disconnect();
      }
    }
  }

  console.warn("Redis Sentinel: unable to attach +switch-master subscriber");
}

async function handleClusterRedirection(
  host: string,
  port: number,
): Promise<void> {
  if (failoverInFlight) return;
  failoverInFlight = true;
  try {
    const nextUrl = buildRedisUrl(host, port);
    if (nextUrl === activeRedisUrl) return;

    const previousUrl = activeRedisUrl;
    activeRedisUrl = nextUrl;
    (redisClient as any).options.url = nextUrl;

    console.warn(
      `Redis Cluster: Redirection detected. Re-configuring client to new master: ${nextUrl} (from ${previousUrl})`,
    );

    if (redisClient.isOpen) {
      try {
        await redisClient.disconnect();
      } catch (err) {
        logger.error(
          "Redis Cluster: Error disconnecting from previous master",
          err,
        );
      }
      try {
        await redisClient.connect();
        console.log(
          `Redis Cluster: Successfully reconnected to new master: ${nextUrl}`,
        );
      } catch (err) {
        logger.error("Redis Cluster: Failed to connect to new master", err);
      }
    }
  } finally {
    failoverInFlight = false;
  }
}

redisClient.on("error", (err) => {
  logger.error("Redis Client Error:", err);
  if (!isRedisClusterOffline) {
    logger.warn(
      "Redis cluster status: offline, falling back to local array caches.",
    );
    isRedisClusterOffline = true;
  }
  if (SENTINEL_ENABLED && /READONLY/i.test(String(err?.message || ""))) {
    void forceFailoverReconnect("redis:readonly");
  }

  // Handle Redis Cluster Redirection Errors (MOVED / ASK)
  const errStr = String(err?.message || "");
  if (/MOVED|ASK/i.test(errStr)) {
    console.warn(`Redis Cluster: Failover warning detected in logs: ${errStr}`);
    const match = errStr.match(/(?:MOVED|ASK)\s+\d+\s+([^\s:]+):(\d+)/i);
    if (match) {
      const [_, host, portStr] = match;
      const port = parseInt(portStr, 10);
      void handleClusterRedirection(host, port);
    }
  }
});

redisClient.on("connect", () => {
  console.log("Redis: Connected successfully");
});

redisClient.on("ready", () => {
  console.log("Redis: Ready");
  if (isRedisClusterOffline) {
    logger.warn("Redis cluster status: online, normal operation restored.");
    isRedisClusterOffline = false;
  }
  void verifyConnectedNodeRole();
});

redisClient.on("reconnecting", () => {
  console.log("Redis: Reconnecting...");
});

export async function connectRedis(): Promise<void> {
  if (SENTINEL_ENABLED) {
    await refreshMasterEndpoint("startup", false);
    await setupSentinelSwitchMasterListener();
  }

  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}

export async function disconnectRedis(): Promise<void> {
  if (sentinelSubscriber) {
    try {
      if (sentinelSubscriber.isOpen) {
        await sentinelSubscriber.quit();
      }
    } catch {
      sentinelSubscriber.disconnect();
    } finally {
      sentinelSubscriber = null;
    }
  }

  if (redisClient.isOpen) {
    await redisClient.quit();
  }
}

const proxyHandler: ProxyHandler<typeof redisClient> = {
  get(target, prop, receiver) {
    if (prop === "get") {
      return async (...args: Parameters<typeof target.get>) => {
        if (isRedisClusterOffline) return getLocalCache(args[0] as string);
        try {
          return await target.get(...args);
        } catch (e) {
          return getLocalCache(args[0] as string);
        }
      };
    }
    if (prop === "set") {
      return async (...args: Parameters<typeof target.set>) => {
        if (isRedisClusterOffline) {
          setLocalCache(args[0] as string, String(args[1]));
          return "OK";
        }
        try {
          return await target.set(...args);
        } catch (e) {
          setLocalCache(args[0] as string, String(args[1]));
          return "OK";
        }
      };
    }
    if (prop === "del") {
      return async (...args: Parameters<typeof target.del>) => {
        if (isRedisClusterOffline) {
          const key = Array.isArray(args[0]) ? args[0][0] : args[0];
          delLocalCache(key as string);
          return 1;
        }
        try {
          return await target.del(...args);
        } catch (e) {
          const key = Array.isArray(args[0]) ? args[0][0] : args[0];
          delLocalCache(key as string);
          return 1;
        }
      };
    }
    return Reflect.get(target, prop, receiver);
  },
};

const exportedRedisClient = new Proxy(redisClient, proxyHandler);
export { exportedRedisClient as redisClient };

export function createRedisStore() {
  return new RedisStore({
    client: redisClient,
    prefix: "session:",
  });
}

export async function flushUserSessions(userId: string): Promise<void> {
  if (!redisClient.isOpen) return;

  try {
    // 1. Set invalidation timestamp to instantly reject active stateless JWTs
    const now = Math.floor(Date.now() / 1000);
    await redisClient.set(`user:${userId}:jwt_invalidated_at`, now.toString());

    // 2. Scan and destroy all express-sessions tied to this user
    let cursor = "0";
    do {
      const reply = await redisClient.scan(cursor, {
        MATCH: "session:*",
        COUNT: 100,
      });
      cursor = String(reply.cursor);

      for (const key of reply.keys) {
        const sessionData = await redisClient.get(key);
        // Fast check: if the stringified session JSON contains the userId
        if (
          sessionData &&
          (sessionData.includes(`"userId":"${userId}"`) ||
            sessionData.includes(`"user_id":"${userId}"`))
        ) {
          await redisClient.del(key);
        }
      }
    } while (cursor !== "0");
  } catch (error) {
    logger.error(`Redis: Failed to flush sessions for user ${userId}`, error);
  }
}
