import {
  TwoFactorRateLimiter,
  twoFactorRateLimiter,
} from "../../src/services/twoFactorRateLimiter";
import { redisClient } from "../../src/config/redis";
import logger from "../../src/utils/logger";

jest.mock("../../src/utils/logger", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  __esModule: true,
}));

describe("TwoFactorRateLimiter", () => {
  let limiter: TwoFactorRateLimiter;

  beforeEach(() => {
    jest.clearAllMocks();
    limiter = new TwoFactorRateLimiter();
    // Default redis to connected state for tests
    (redisClient as any).isOpen = true;
    (redisClient as any).get = jest.fn();
    (redisClient as any).incr = jest.fn();
    (redisClient as any).expire = jest.fn();
    (redisClient as any).del = jest.fn();
    (redisClient as any).ttl = jest.fn();
  });

  describe("Consecutive failed attempts & lockout counting", () => {
    it("increments failure count correctly and sets expiry on the first failure", async () => {
      const userId = "user-123";
      (redisClient.incr as jest.Mock).mockResolvedValue(1);

      const count = await limiter.incrementFailures(userId);

      expect(count).toBe(1);
      expect(redisClient.incr).toHaveBeenCalledWith("2fa:lockout:user-123");
      expect(redisClient.expire).toHaveBeenCalledWith(
        "2fa:lockout:user-123",
        900,
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("does not reset key expiry on subsequent failed attempts", async () => {
      const userId = "user-123";
      (redisClient.incr as jest.Mock).mockResolvedValue(2);

      const count = await limiter.incrementFailures(userId);

      expect(count).toBe(2);
      expect(redisClient.incr).toHaveBeenCalledWith("2fa:lockout:user-123");
      expect(redisClient.expire).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("locks out account when maximum attempts (3) are reached and logs warning", async () => {
      const userId = "user-123";
      (redisClient.incr as jest.Mock).mockResolvedValue(3);

      const count = await limiter.incrementFailures(userId);

      expect(count).toBe(3);
      expect(logger.warn).toHaveBeenCalledWith(
        "[2FA] User user-123 has been locked out after 3 failed attempts",
      );
    });

    it("correctly identifies account locked state via isLocked", async () => {
      const userId = "user-123";

      // 0 attempts (key missing)
      (redisClient.get as jest.Mock).mockResolvedValue(null);
      expect(await limiter.isLocked(userId)).toBe(false);

      // 2 attempts (under limit)
      (redisClient.get as jest.Mock).mockResolvedValue("2");
      expect(await limiter.isLocked(userId)).toBe(false);

      // 3 attempts (reached limit)
      (redisClient.get as jest.Mock).mockResolvedValue("3");
      expect(await limiter.isLocked(userId)).toBe(true);

      // > 3 attempts
      (redisClient.get as jest.Mock).mockResolvedValue("5");
      expect(await limiter.isLocked(userId)).toBe(true);
    });
  });

  describe("Cooldown window, lockout expiry, and reset", () => {
    it("resets failure counter when resetFailures is called (e.g. successful auth)", async () => {
      const userId = "user-123";
      (redisClient.del as jest.Mock).mockResolvedValue(1);

      await limiter.resetFailures(userId);

      expect(redisClient.del).toHaveBeenCalledWith("2fa:lockout:user-123");
    });

    it("calculates remaining tries correctly before and after max attempts", async () => {
      const userId = "user-123";

      (redisClient.get as jest.Mock).mockResolvedValue(null);
      expect(await limiter.getRemainingTries(userId)).toBe(3);

      (redisClient.get as jest.Mock).mockResolvedValue("1");
      expect(await limiter.getRemainingTries(userId)).toBe(2);

      (redisClient.get as jest.Mock).mockResolvedValue("3");
      expect(await limiter.getRemainingTries(userId)).toBe(0);

      (redisClient.get as jest.Mock).mockResolvedValue("4");
      expect(await limiter.getRemainingTries(userId)).toBe(0);
    });

    it("returns remaining lockout TTL in seconds", async () => {
      const userId = "user-123";

      (redisClient.ttl as jest.Mock).mockResolvedValue(450);
      expect(await limiter.getLockoutTimeRemaining(userId)).toBe(450);
    });

    it("returns 0 for lockout time remaining when key is expired or missing (negative TTL)", async () => {
      const userId = "user-123";

      // Redis returns -2 when key does not exist / expired
      (redisClient.ttl as jest.Mock).mockResolvedValue(-2);
      expect(await limiter.getLockoutTimeRemaining(userId)).toBe(0);

      // Redis returns -1 when key exists with no expire
      (redisClient.ttl as jest.Mock).mockResolvedValue(-1);
      expect(await limiter.getLockoutTimeRemaining(userId)).toBe(0);
    });
  });

  describe("Edge Cases", () => {
    it("handles rapid concurrent submissions safely", async () => {
      const userId = "user-concurrent";
      let count = 0;

      (redisClient.incr as jest.Mock).mockImplementation(async () => {
        count += 1;
        return count;
      });

      const results = await Promise.all([
        limiter.incrementFailures(userId),
        limiter.incrementFailures(userId),
        limiter.incrementFailures(userId),
      ]);

      expect(results).toEqual([1, 2, 3]);
      expect(redisClient.expire).toHaveBeenCalledTimes(1);
      expect(redisClient.expire).toHaveBeenCalledWith(
        "2fa:lockout:user-concurrent",
        900,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        `[2FA] User ${userId} has been locked out after 3 failed attempts`,
      );
    });

    it("handles expired keys seamlessly when user checks lock status after lockout duration", async () => {
      const userId = "user-expired";

      // Simulate expired key in redis
      (redisClient.get as jest.Mock).mockResolvedValue(null);
      (redisClient.ttl as jest.Mock).mockResolvedValue(-2);

      expect(await limiter.isLocked(userId)).toBe(false);
      expect(await limiter.getRemainingTries(userId)).toBe(3);
      expect(await limiter.getLockoutTimeRemaining(userId)).toBe(0);
    });

    it("generates correct rate-limit headers when active", async () => {
      const userId = "user-123";

      (redisClient.get as jest.Mock).mockResolvedValue("1");
      (redisClient.ttl as jest.Mock).mockResolvedValue(600);

      const headers = await limiter.getRateLimitHeaders(userId);

      expect(headers).toEqual({
        limit: 3,
        remaining: 2,
        resetAt: expect.any(String),
        retryAfter: 600,
      });
      expect(new Date(headers.resetAt).getTime()).not.toBeNaN();
    });

    it("generates correct rate-limit headers when no previous attempts exist", async () => {
      const userId = "user-fresh";

      (redisClient.get as jest.Mock).mockResolvedValue(null);
      (redisClient.ttl as jest.Mock).mockResolvedValue(-2);

      const headers = await limiter.getRateLimitHeaders(userId);

      expect(headers).toEqual({
        limit: 3,
        remaining: 3,
        resetAt: expect.any(String),
        retryAfter: 0,
      });
    });
  });

  describe("Redis Offline / Disconnected Fallbacks", () => {
    beforeEach(() => {
      (redisClient as any).isOpen = false;
    });

    it("isLocked returns false when Redis is offline", async () => {
      expect(await limiter.isLocked("user-123")).toBe(false);
    });

    it("incrementFailures returns 0 when Redis is offline", async () => {
      expect(await limiter.incrementFailures("user-123")).toBe(0);
    });

    it("resetFailures gracefully completes without error when Redis is offline", async () => {
      await expect(limiter.resetFailures("user-123")).resolves.toBeUndefined();
    });

    it("getRemainingTries returns MAX_ATTEMPTS when Redis is offline", async () => {
      expect(await limiter.getRemainingTries("user-123")).toBe(3);
    });

    it("getLockoutTimeRemaining returns 0 when Redis is offline", async () => {
      expect(await limiter.getLockoutTimeRemaining("user-123")).toBe(0);
    });

    it("getRateLimitHeaders returns default headers when Redis is offline", async () => {
      const headers = await limiter.getRateLimitHeaders("user-123");
      expect(headers).toEqual({
        limit: 3,
        remaining: 3,
        resetAt: expect.any(String),
        retryAfter: 900,
      });
    });
  });

  describe("Singleton Instance", () => {
    it("exports a valid twoFactorRateLimiter instance", () => {
      expect(twoFactorRateLimiter).toBeInstanceOf(TwoFactorRateLimiter);
    });
  });
});
