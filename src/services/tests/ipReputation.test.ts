/**
 * Unit tests for IP reputation tracker — issue #2465
 */

jest.mock("../../config/redis", () => {
  const store: Record<string, { value: string; ttl: number }> = {};
  const redis: any = {
    isOpen: true,
    store,
    incr: jest.fn(async (key: string) => {
      store[key] = store[key] ?? { value: "0", ttl: -1 };
      store[key].value = String(parseInt(store[key].value, 10) + 1);
      return parseInt(store[key].value, 10);
    }),
    get: jest.fn(async (key: string) => store[key]?.value ?? null),
    set: jest.fn(async (key: string, value: string, opts?: any) => {
      if (opts?.NX && store[key]?.ttl > 0) return null;
      store[key] = { value, ttl: opts?.EX ?? -1 };
      return "OK";
    }),
    del: jest.fn(async (keys: string | string[]) => {
      const ks = Array.isArray(keys) ? keys : [keys];
      let count = 0;
      for (const k of ks) {
        if (store[k]) { delete store[k]; count++; }
      }
      return count;
    }),
    expire: jest.fn(async (key: string, ttl: number) => {
      if (store[key]) { store[key].ttl = ttl; return 1; }
      return 0;
    }),
    ttl: jest.fn(async (key: string) => store[key]?.ttl ?? -2),
    scan: jest.fn(async () => ({ cursor: 0, keys: [] })),
  };
  return { redisClient: redis, flushUserSessions: jest.fn() };
});

jest.mock("../../utils/logger", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Clear store between tests
afterEach(() => {
  const { redisClient } = require("../../config/redis");
  for (const key of Object.keys(redisClient.store)) {
    delete redisClient.store[key];
  }
  jest.clearAllMocks();
});

import {
  recordFailure,
  isIpBlocked,
  getIpStatus,
  adminUnblockIp,
  listBlockedIps,
  extractClientIp,
} from "../ipReputation";

const IP = "192.168.1.100";

// ---------------------------------------------------------------------------
// recordFailure
// ---------------------------------------------------------------------------

describe("recordFailure", () => {
  it("returns blocked=false before threshold is reached", async () => {
    for (let i = 0; i < 19; i++) {
      const r = await recordFailure(IP);
      expect(r.blocked).toBe(false);
    }
  });

  it("returns justBlocked=true on the threshold-crossing call", async () => {
    for (let i = 0; i < 19; i++) await recordFailure(IP);
    const r = await recordFailure(IP);
    expect(r.blocked).toBe(true);
    expect(r.justBlocked).toBe(true);
  });

  it("returns blocked=true without justBlocked on subsequent calls", async () => {
    for (let i = 0; i < 20; i++) await recordFailure(IP);
    const r = await recordFailure(IP);
    expect(r.blocked).toBe(true);
    expect(r.justBlocked).toBe(false);
  });

  it("sets expiry on the failure counter on first increment", async () => {
    const { redisClient } = require("../../config/redis");
    await recordFailure(IP);
    expect(redisClient.expire).toHaveBeenCalledWith(
      `ip:fail:${IP}`,
      expect.any(Number),
    );
  });

  it("writes the block key with EX and NX when threshold breached", async () => {
    const { redisClient } = require("../../config/redis");
    for (let i = 0; i < 20; i++) await recordFailure(IP);
    expect(redisClient.set).toHaveBeenCalledWith(
      `ip:block:${IP}`,
      "1",
      expect.objectContaining({ EX: expect.any(Number), NX: true }),
    );
  });

  it("deletes the counter key after blocking", async () => {
    const { redisClient } = require("../../config/redis");
    for (let i = 0; i < 20; i++) await recordFailure(IP);
    expect(redisClient.del).toHaveBeenCalledWith(`ip:fail:${IP}`);
  });

  it("returns blocked=false when Redis is not available", async () => {
    const { redisClient } = require("../../config/redis");
    redisClient.isOpen = false;
    const r = await recordFailure(IP);
    expect(r.blocked).toBe(false);
    redisClient.isOpen = true;
  });
});

// ---------------------------------------------------------------------------
// isIpBlocked
// ---------------------------------------------------------------------------

describe("isIpBlocked", () => {
  it("returns false for a fresh IP", async () => {
    expect(await isIpBlocked(IP)).toBe(false);
  });

  it("returns true after IP is blocked", async () => {
    for (let i = 0; i < 20; i++) await recordFailure(IP);
    expect(await isIpBlocked(IP)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getIpStatus
// ---------------------------------------------------------------------------

describe("getIpStatus", () => {
  it("returns zeroed status for an unknown IP", async () => {
    const status = await getIpStatus("10.0.0.1");
    expect(status.isBlocked).toBe(false);
    expect(status.failureCount).toBe(0);
    expect(status.blockTtlSeconds).toBeNull();
  });

  it("tracks failure count before blocking", async () => {
    await recordFailure(IP);
    await recordFailure(IP);
    const status = await getIpStatus(IP);
    expect(status.failureCount).toBe(2);
    expect(status.isBlocked).toBe(false);
  });

  it("shows isBlocked=true and blockTtlSeconds after blocking", async () => {
    for (let i = 0; i < 20; i++) await recordFailure(IP);
    const status = await getIpStatus(IP);
    expect(status.isBlocked).toBe(true);
    expect(status.blockTtlSeconds).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// adminUnblockIp
// ---------------------------------------------------------------------------

describe("adminUnblockIp", () => {
  it("removes block and returns true", async () => {
    for (let i = 0; i < 20; i++) await recordFailure(IP);
    const removed = await adminUnblockIp(IP);
    expect(removed).toBe(true);
    expect(await isIpBlocked(IP)).toBe(false);
  });

  it("returns false if IP was not blocked", async () => {
    const removed = await adminUnblockIp("1.2.3.4");
    expect(removed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listBlockedIps
// ---------------------------------------------------------------------------

describe("listBlockedIps", () => {
  it("returns empty array when no IPs are blocked", async () => {
    const { redisClient } = require("../../config/redis");
    redisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: [] });
    expect(await listBlockedIps()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractClientIp
// ---------------------------------------------------------------------------

describe("extractClientIp", () => {
  it("extracts the first IP from X-Forwarded-For", () => {
    const req = {
      ip: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    };
    expect(extractClientIp(req)).toBe("203.0.113.5");
  });

  it("falls back to req.ip when X-Forwarded-For is absent", () => {
    const req = { ip: "10.0.0.5", headers: {} };
    expect(extractClientIp(req)).toBe("10.0.0.5");
  });

  it("returns 'unknown' when no IP is available", () => {
    expect(extractClientIp({ ip: undefined, headers: {} })).toBe("unknown");
  });

  it("handles array X-Forwarded-For header", () => {
    const req = {
      ip: "127.0.0.1",
      headers: { "x-forwarded-for": ["203.0.113.10", "10.0.0.1"] as any },
    };
    expect(extractClientIp(req)).toBe("203.0.113.10");
  });
});
