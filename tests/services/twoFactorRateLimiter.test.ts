import { jest } from "@jest/globals";
import { redisClient } from "../../src/config/redis";
import logger from "../../src/utils/logger";
import {
  TwoFactorRateLimiter,
  twoFactorRateLimiter,
} from "../../src/services/twoFactorRateLimiter";

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    isOpen: true,
    get: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
    ttl: jest.fn(),
  },
}));

jest.mock("../../src/utils/logger", () => {
  const warn = jest.fn();
  const info = jest.fn();
  const error = jest.fn();
  return {
    __esModule: true,
    default: {
      info,
      warn,
      error,
    },
    info,
    warn,
    error,
  };
});

describe("TwoFactorRateLimiter Service", () => {
  let limiter: TwoFactorRateLimiter;
  const mockRedis = redisClient as jest.Mocked<typeof redisClient>;
  const mockWarn = logger.warn as unknown as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.isOpen = true;
    limiter = new TwoFactorRateLimiter();
  });

  describe("Singleton Export", () => {
    it("exports singleton instance of TwoFactorRateLimiter", () => {
      expect(twoFactorRateLimiter).toBeInstanceOf(TwoFactorRateLimiter);
    });
  });

  describe("isLocked", () => {
    it("returns false if Redis is not connected", async () => {
      mockRedis.isOpen = false;
      const locked = await limiter.isLocked("user-1");
      expect(locked).toBe(false);
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it("returns false if user has no failed attempts in Redis", async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce(null);
      const locked = await limiter.isLocked("user-1");
      expect(locked).toBe(false);
      expect(mockRedis.get).toHaveBeenCalledWith("2fa:lockout:user-1");
    });

    it("returns false if user has failed attempts below MAX_ATTEMPTS threshold", async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce("2");
      const locked = await limiter.isLocked("user-1");
      expect(locked).toBe(false);
    });

    it("returns true if user has failed attempts equal to MAX_ATTEMPTS", async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce("3");
      const locked = await limiter.isLocked("user-1");
      expect(locked).toBe(true);
    });

    it("returns true if user has failed attempts exceeding MAX_ATTEMPTS", async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce("5");
      const locked = await limiter.isLocked("user-1");
      expect(locked).toBe(true);
    });
  });

  describe("incrementFailures", () => {
    it("returns 0 if Redis is not connected", async () => {
      mockRedis.isOpen = false;
      const count = await limiter.incrementFailures("user-1");
      expect(count).toBe(0);
      expect(mockRedis.incr).not.toHaveBeenCalled();
    });

    it("increments attempt counter and sets expiration on first failure", async () => {
      (mockRedis.incr as jest.Mock).mockResolvedValueOnce(1);
      (mockRedis.expire as jest.Mock).mockResolvedValueOnce(true);

      const count = await limiter.incrementFailures("user-1");
      expect(count).toBe(1);
      expect(mockRedis.incr).toHaveBeenCalledWith("2fa:lockout:user-1");
      expect(mockRedis.expire).toHaveBeenCalledWith("2fa:lockout:user-1", 15 * 60);
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it("increments counter without resetting expiration on subsequent failures", async () => {
      (mockRedis.incr as jest.Mock).mockResolvedValueOnce(2);

      const count = await limiter.incrementFailures("user-1");
      expect(count).toBe(2);
      expect(mockRedis.incr).toHaveBeenCalledWith("2fa:lockout:user-1");
      expect(mockRedis.expire).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it("logs warning when failed attempts reach or exceed MAX_ATTEMPTS", async () => {
      (mockRedis.incr as jest.Mock).mockResolvedValueOnce(3);

      const count = await limiter.incrementFailures("user-1");
      expect(count).toBe(3);
      expect(mockRedis.expire).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(
        "[2FA] User user-1 has been locked out after 3 failed attempts",
      );
    });

    it("handles rapid concurrent failure increments accurately", async () => {
      let currentVal = 0;
      (mockRedis.incr as jest.Mock).mockImplementation(async () => {
        currentVal += 1;
        return currentVal;
      });
      (mockRedis.expire as jest.Mock).mockResolvedValue(true);

      const results = await Promise.all([
        limiter.incrementFailures("user-concurrent"),
        limiter.incrementFailures("user-concurrent"),
        limiter.incrementFailures("user-concurrent"),
      ]);

      expect(results).toEqual([1, 2, 3]);
      expect(mockRedis.expire).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledTimes(1);
    });
  });

  describe("resetFailures", () => {
    it("does nothing when Redis is not connected", async () => {
      mockRedis.isOpen = false;
      await limiter.resetFailures("user-1");
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it("deletes the Redis lockout key upon successful authentication", async () => {
      (mockRedis.del as jest.Mock).mockResolvedValueOnce(1);

      await limiter.resetFailures("user-1");
      expect(mockRedis.del).toHaveBeenCalledWith("2fa:lockout:user-1");
    });
  });

  describe("getRemainingTries", () => {
    it("returns MAX_ATTEMPTS if Redis is not connected", async () => {
      mockRedis.isOpen = false;
      const tries = await limiter.getRemainingTries("user-1");
      expect(tries).toBe(3);
    });

    it("returns MAX_ATTEMPTS if no failed attempts exist", async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce(null);
      const tries = await limiter.getRemainingTries("user-1");
      expect(tries).toBe(3);
    });

    it("returns remaining attempts when below limit", async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce("2");
      const tries = await limiter.getRemainingTries("user-1");
      expect(tries).toBe(1);
    });

    it("returns 0 remaining attempts when max attempts reached or exceeded", async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce("3");
      const tries1 = await limiter.getRemainingTries("user-1");
      expect(tries1).toBe(0);

      (mockRedis.get as jest.Mock).mockResolvedValueOnce("5");
      const tries2 = await limiter.getRemainingTries("user-1");
      expect(tries2).toBe(0);
    });
  });

  describe("getLockoutTimeRemaining", () => {
    it("returns 0 if Redis is not connected", async () => {
      mockRedis.isOpen = false;
      const time = await limiter.getLockoutTimeRemaining("user-1");
      expect(time).toBe(0);
    });

    it("returns TTL in seconds when key has remaining lifetime", async () => {
      (mockRedis.ttl as jest.Mock).mockResolvedValueOnce(450);
      const time = await limiter.getLockoutTimeRemaining("user-1");
      expect(time).toBe(450);
      expect(mockRedis.ttl).toHaveBeenCalledWith("2fa:lockout:user-1");
    });

    it("returns 0 when TTL is negative (expired or non-existent key)", async () => {
      (mockRedis.ttl as jest.Mock).mockResolvedValueOnce(-2);
      const time = await limiter.getLockoutTimeRemaining("user-1");
      expect(time).toBe(0);
    });
  });

  describe("getRateLimitHeaders", () => {
    it("returns default headers when Redis is disconnected", async () => {
      mockRedis.isOpen = false;
      const headers = await limiter.getRateLimitHeaders("user-1");

      expect(headers.limit).toBe(3);
      expect(headers.remaining).toBe(3);
      expect(headers.retryAfter).toBe(900);
      expect(new Date(headers.resetAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("returns standard rate-limit headers for account with zero attempts", async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce(null);
      (mockRedis.ttl as jest.Mock).mockResolvedValueOnce(-2);

      const headers = await limiter.getRateLimitHeaders("user-1");

      expect(headers).toMatchObject({
        limit: 3,
        remaining: 3,
        retryAfter: 0,
      });
      expect(headers.resetAt).toContain("T");
    });

    it("returns standard rate-limit headers for account with active attempts", async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce("2");
      (mockRedis.ttl as jest.Mock).mockResolvedValueOnce(720);

      const headers = await limiter.getRateLimitHeaders("user-1");

      expect(headers).toMatchObject({
        limit: 3,
        remaining: 1,
        retryAfter: 720,
      });
      expect(headers.resetAt).toContain("T");
    });

    it("returns zero remaining and active lockout TTL for locked account", async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce("4");
      (mockRedis.ttl as jest.Mock).mockResolvedValueOnce(600);

      const headers = await limiter.getRateLimitHeaders("user-1");

      expect(headers).toMatchObject({
        limit: 3,
        remaining: 0,
        retryAfter: 600,
      });
      expect(headers.resetAt).toContain("T");
    });
  });
});
