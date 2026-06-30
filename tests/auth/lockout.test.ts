/**
 * Unit tests for the Redis-backed account lockout service.
 *
 * Redis is mocked so tests run without an actual Redis server.
 */

import { EventEmitter } from "events";

// ── Redis mock ────────────────────────────────────────────────────────────────

const store = new Map<string, { value: string; expiresAt: number | null }>();

const mockRedis = {
  isOpen: true,
  async incr(key: string): Promise<number> {
    const entry = store.get(key);
    const current = entry ? parseInt(entry.value, 10) : 0;
    const next = current + 1;
    store.set(key, {
      value: String(next),
      expiresAt: entry?.expiresAt ?? null,
    });
    return next;
  },
  async expire(key: string, ttl: number): Promise<number> {
    const entry = store.get(key);
    if (entry) {
      store.set(key, { ...entry, expiresAt: Date.now() + ttl * 1000 });
    }
    return 1;
  },
  async set(
    key: string,
    value: string,
    opts?: { EX?: number; NX?: boolean },
  ): Promise<string | null> {
    if (opts?.NX && store.has(key)) return null;
    store.set(key, {
      value,
      expiresAt: opts?.EX != null ? Date.now() + opts.EX * 1000 : null,
    });
    return "OK";
  },
  async get(key: string): Promise<string | null> {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value;
  },
  async del(keys: string | string[]): Promise<number> {
    const list = Array.isArray(keys) ? keys : [keys];
    let deleted = 0;
    for (const k of list) {
      if (store.delete(k)) deleted++;
    }
    return deleted;
  },
  async ttl(key: string): Promise<number> {
    const entry = store.get(key);
    if (!entry || entry.expiresAt === null) return -1;
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return -2;
    }
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  },
};

jest.mock("../../src/config/redis", () => ({ redisClient: mockRedis }));

// ─── Import after mock ────────────────────────────────────────────────────────

import {
  getLockoutStatus,
  recordFailedAttempt,
  recordSuccessfulLogin,
  adminUnlock,
  isAccountLocked,
  lockoutEvents,
} from "../../src/auth/lockout";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PHONE = "+1234567890";

function clearStore() {
  store.clear();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Account lockout — Redis-backed", () => {
  beforeEach(() => {
    clearStore();
    process.env.MAX_LOGIN_ATTEMPTS = "5";
    process.env.LOCKOUT_WINDOW_MINUTES = "10";
    process.env.LOCKOUT_DURATION_MINUTES = "30";
  });

  // ── getLockoutStatus ───────────────────────────────────────────────────────

  describe("getLockoutStatus", () => {
    it("returns unlocked with full attempts when no record exists", async () => {
      const status = await getLockoutStatus(PHONE);
      expect(status.isLocked).toBe(false);
      expect(status.attemptsRemaining).toBe(5);
      expect(status.lockedAt).toBeNull();
      expect(status.unlocksAt).toBeNull();
    });

    it("returns correct attemptsRemaining after partial failures", async () => {
      await recordFailedAttempt(PHONE);
      await recordFailedAttempt(PHONE);
      const status = await getLockoutStatus(PHONE);
      expect(status.isLocked).toBe(false);
      expect(status.attemptsRemaining).toBe(3);
    });

    it("returns isLocked true and positive minutesRemaining when locked", async () => {
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE);
      const status = await getLockoutStatus(PHONE);
      expect(status.isLocked).toBe(true);
      expect(status.attemptsRemaining).toBe(0);
      expect(status.minutesRemaining).toBeGreaterThan(0);
      expect(status.unlocksAt).toBeInstanceOf(Date);
    });

    it("returns unlocked when Redis is not ready", async () => {
      mockRedis.isOpen = false;
      const status = await getLockoutStatus(PHONE);
      expect(status.isLocked).toBe(false);
      mockRedis.isOpen = true;
    });
  });

  // ── recordFailedAttempt ────────────────────────────────────────────────────

  describe("recordFailedAttempt", () => {
    it("increments counter and returns correct attemptsRemaining", async () => {
      const r1 = await recordFailedAttempt(PHONE);
      expect(r1.lockoutStatus.attemptsRemaining).toBe(4);
      expect(r1.justLocked).toBe(false);

      const r2 = await recordFailedAttempt(PHONE);
      expect(r2.lockoutStatus.attemptsRemaining).toBe(3);
    });

    it("locks account on the 5th failure and sets justLocked = true", async () => {
      for (let i = 0; i < 4; i++) await recordFailedAttempt(PHONE);
      const r = await recordFailedAttempt(PHONE);
      expect(r.justLocked).toBe(true);
      expect(r.lockoutStatus.isLocked).toBe(true);
      expect(r.lockoutStatus.attemptsRemaining).toBe(0);
    });

    it("returns justLocked = false on subsequent calls after lock", async () => {
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE);
      const r = await recordFailedAttempt(PHONE);
      expect(r.justLocked).toBe(false);
      expect(r.lockoutStatus.isLocked).toBe(true);
    });

    it("message warns when only 1 attempt remains", async () => {
      for (let i = 0; i < 3; i++) await recordFailedAttempt(PHONE);
      const r = await recordFailedAttempt(PHONE); // 4th attempt → 1 remaining
      expect(r.message).toContain("Warning: 1 attempt remaining");
    });

    it("message includes attempt count for more than 1 remaining", async () => {
      const r = await recordFailedAttempt(PHONE); // 1st → 4 remaining
      expect(r.message).toContain("4 attempts remaining");
    });

    it("emits 'locked' event when account becomes locked", async () => {
      const handler = jest.fn();
      lockoutEvents.once("locked", handler);
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: PHONE, attempts: 5 }),
      );
    });

    it("emits 'failedAttempt' event for non-locking failures", async () => {
      const handler = jest.fn();
      lockoutEvents.once("failedAttempt", handler);
      await recordFailedAttempt(PHONE);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: PHONE, attempts: 1 }),
      );
    });
  });

  // ── recordSuccessfulLogin ─────────────────────────────────────────────────

  describe("recordSuccessfulLogin", () => {
    it("clears attempt counter on success", async () => {
      await recordFailedAttempt(PHONE);
      await recordFailedAttempt(PHONE);
      await recordSuccessfulLogin(PHONE);
      const status = await getLockoutStatus(PHONE);
      expect(status.attemptsRemaining).toBe(5);
    });

    it("clears an active lock", async () => {
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE);
      expect((await getLockoutStatus(PHONE)).isLocked).toBe(true);
      await recordSuccessfulLogin(PHONE);
      expect((await getLockoutStatus(PHONE)).isLocked).toBe(false);
    });

    it("emits 'reset' event when records are cleared", async () => {
      const handler = jest.fn();
      lockoutEvents.once("reset", handler);
      await recordFailedAttempt(PHONE);
      await recordSuccessfulLogin(PHONE);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          identifier: PHONE,
          reason: "successful_login",
        }),
      );
    });

    it("is safe to call when no record exists", async () => {
      await expect(recordSuccessfulLogin(PHONE)).resolves.toBeUndefined();
    });
  });

  // ── adminUnlock ────────────────────────────────────────────────────────────

  describe("adminUnlock", () => {
    it("returns true and unlocks a locked account", async () => {
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE);
      const result = await adminUnlock(PHONE, "admin-1");
      expect(result).toBe(true);
      expect((await getLockoutStatus(PHONE)).isLocked).toBe(false);
    });

    it("returns true and clears a partial attempt counter", async () => {
      await recordFailedAttempt(PHONE);
      const result = await adminUnlock(PHONE);
      expect(result).toBe(true);
      expect((await getLockoutStatus(PHONE)).attemptsRemaining).toBe(5);
    });

    it("returns false when there is nothing to unlock", async () => {
      const result = await adminUnlock(PHONE);
      expect(result).toBe(false);
    });

    it("emits 'unlocked' event with adminId", async () => {
      const handler = jest.fn();
      lockoutEvents.once("unlocked", handler);
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE);
      await adminUnlock(PHONE, "admin-42");
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: PHONE, adminId: "admin-42" }),
      );
    });
  });

  // ── isAccountLocked ────────────────────────────────────────────────────────

  describe("isAccountLocked", () => {
    it("returns false when no record exists", async () => {
      expect(await isAccountLocked(PHONE)).toBe(false);
    });

    it("returns false after partial failures", async () => {
      await recordFailedAttempt(PHONE);
      expect(await isAccountLocked(PHONE)).toBe(false);
    });

    it("returns true after account is locked", async () => {
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE);
      expect(await isAccountLocked(PHONE)).toBe(true);
    });

    it("returns false after adminUnlock", async () => {
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE);
      await adminUnlock(PHONE);
      expect(await isAccountLocked(PHONE)).toBe(false);
    });
  });

  // ── identifier isolation ───────────────────────────────────────────────────

  describe("identifier isolation", () => {
    const PHONE_B = "+9876543210";

    it("does not share state between different identifiers", async () => {
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE);
      expect(await isAccountLocked(PHONE)).toBe(true);
      expect(await isAccountLocked(PHONE_B)).toBe(false);
    });

    it("unlocking one identifier does not affect another", async () => {
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE);
      for (let i = 0; i < 5; i++) await recordFailedAttempt(PHONE_B);
      await adminUnlock(PHONE);
      expect(await isAccountLocked(PHONE)).toBe(false);
      expect(await isAccountLocked(PHONE_B)).toBe(true);
    });
  });

  // ── window-based counter ───────────────────────────────────────────────────

  describe("sliding window counter", () => {
    it("locks account on exactly MAX_LOGIN_ATTEMPTS failures", async () => {
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(await recordFailedAttempt(PHONE));
      }
      const lastResult = results[results.length - 1];
      expect(lastResult.justLocked).toBe(true);
      expect(lastResult.lockoutStatus.isLocked).toBe(true);
    });

    it("does not lock on MAX_LOGIN_ATTEMPTS - 1 failures", async () => {
      for (let i = 0; i < 4; i++) await recordFailedAttempt(PHONE);
      expect(await isAccountLocked(PHONE)).toBe(false);
    });
  });
});
