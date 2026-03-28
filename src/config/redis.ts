import { createClient } from "redis";
import RedisStore from "connect-redis";

export const SESSION_TTL_SECONDS = parseInt(
  process.env.SESSION_TTL_SECONDS || "86400",
);

type SentinelNode = {
  host: string;
  port: number;
};

const DEFAULT_REDIS_URL = "redis://localhost:6379";
const BASE_REDIS_URL = process.env.REDIS_URL || DEFAULT_REDIS_URL;
const SENTINEL_MASTER_NAME = process.env.REDIS_SENTINEL_MASTER_NAME || "mymaster";
const SENTINEL_USERNAME = process.env.REDIS_SENTINEL_USERNAME;
const SENTINEL_PASSWORD = process.env.REDIS_SENTINEL_PASSWORD;

const SENTINEL_NODES = parseSentinelNodes(process.env.REDIS_SENTINELS);
const SENTINEL_ENABLED = SENTINEL_NODES.length > 0;

let activeRedisUrl = BASE_REDIS_URL;
let masterRefreshInFlight: Promise<boolean> | null = null;
let roleVerificationInFlight = false;
let failoverInFlight = false;
let sentinelSubscriber: ReturnType<typeof createClient> | null = null;

const redisClient = createClient({
  url: activeRedisUrl,
  socket: {
    reconnectStrategy: (retries, cause) => {
      if (SENTINEL_ENABLED) {
        void scheduleMasterRefresh("reconnect");
      }

      if (retries > 100) {
        console.error("Redis: Max reconnection attempts reached", { cause });
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
      console.error("Redis: reconnect after master endpoint update failed", error);
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
  if (!SENTINEL_ENABLED || !redisClient.isOpen || roleVerificationInFlight) return;
  roleVerificationInFlight = true;
  try {
    const roleResponse = (await redisClient.sendCommand(["ROLE"])) as unknown;
    if (!Array.isArray(roleResponse) || roleResponse.length === 0) return;

    const role = String(roleResponse[0] || "").toLowerCase();
    if (role !== "master") {
      console.warn("Redis: connected node is not master; forcing failover reconnect", {
        role,
      });
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

redisClient.on("error", (err) => {
  console.error("Redis Client Error:", err);
  if (SENTINEL_ENABLED && /READONLY/i.test(String(err?.message || ""))) {
    void forceFailoverReconnect("redis:readonly");
  }
});

redisClient.on("connect", () => {
  console.log("Redis: Connected successfully");
});

redisClient.on("ready", () => {
  console.log("Redis: Ready");
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

export { redisClient };

export function createRedisStore() {
  return new RedisStore({
    client: redisClient,
    prefix: "session:",
  });
}
