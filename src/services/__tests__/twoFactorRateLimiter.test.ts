import { jest } from "@jest/globals";
import { redisClient } from "../../config/redis";
import logger from "../../utils/logger";
import {
  FAILURE_WINDOW_SECONDS,
  LOCKOUT_DURATION_SECONDS,
  MAX_ATTEMPTS,
  TwoFactorRateLimiter,
} from "../twoFactorRateLimiter";

const mockQueryWrite = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
const mockSendAccountLockoutNotification = jest.fn().mockResolvedValue(undefined);

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    get: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
    ttl: jest.fn(),
  },
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock("../../config/database", () => ({
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
}));

jest.mock("../email", () => ({
  emailService: {
    sendAccountLockoutNotification: (...args: unknown[]) =>
      mockSendAccountLockoutNotification(...args),
  },
}));

describe("TwoFactorRateLimiter headers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns standard rate-limit headers for a locked 2FA account", async () => {
    const limiter = new TwoFactorRateLimiter();
    const getMock = redisClient.get as jest.MockedFunction<
      typeof redisClient.get
    >;
    const ttlMock = redisClient.ttl as jest.MockedFunction<
      typeof redisClient.ttl
    >;

    getMock.mockResolvedValue("5");
    ttlMock.mockResolvedValue(600);

    const headers = await limiter.getRateLimitHeaders("user-123");

    expect(headers).toMatchObject({
      limit: 5,
      remaining: 0,
      retryAfter: 600,
    });
    expect(headers.resetAt).toContain("T");
  });
});

describe("TwoFactorRateLimiter brute-force protection", () => {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryWrite.mockClear().mockResolvedValue({ rows: [], rowCount: 1 });
    mockSendAccountLockoutNotification.mockClear().mockResolvedValue(undefined);
    store.clear();
    ttls.clear();
    (redisClient.incr as jest.Mock).mockImplementation(async (key: unknown) => {
      const next = (store.get(String(key)) ?? 0) + 1;
      store.set(String(key), next);
      return next;
    });
    (redisClient.get as jest.Mock).mockImplementation(async (key: unknown) => {
      const value = store.get(String(key));
      return value === undefined ? null : String(value);
    });
    (redisClient.expire as jest.Mock).mockImplementation(
      async (key: unknown, seconds: unknown) => {
        ttls.set(String(key), Number(seconds));
        return true;
      },
    );
    (redisClient.ttl as jest.Mock).mockImplementation(
      async (key: unknown) => ttls.get(String(key)) ?? -2,
    );
    (redisClient.del as jest.Mock).mockImplementation(async (key: unknown) => {
      store.delete(String(key));
      ttls.delete(String(key));
      return 1;
    });
  });

  it("locks the account for 30 minutes after 5 consecutive failures within the 15-minute window (#2380)", async () => {
    const limiter = new TwoFactorRateLimiter();
    const warnSpy = jest.spyOn(logger, "warn");

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await limiter.incrementFailures("admin-1");
      expect(await limiter.isLocked("admin-1")).toBe(false);
    }
    expect(warnSpy).not.toHaveBeenCalled();

    await limiter.incrementFailures("admin-1");

    expect(await limiter.isLocked("admin-1")).toBe(true);
    expect(await limiter.getRemainingTries("admin-1")).toBe(0);
    expect(await limiter.getLockoutTimeRemaining("admin-1")).toBe(
      LOCKOUT_DURATION_SECONDS,
    );
    expect(LOCKOUT_DURATION_SECONDS).toBe(30 * 60);
    expect(FAILURE_WINDOW_SECONDS).toBe(15 * 60);
    // TTL is refreshed when the lockout starts, not only on the first failure
    expect(redisClient.expire).toHaveBeenCalledTimes(2);
    // First expire call sets the 15-minute counting window...
    expect(redisClient.expire).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      FAILURE_WINDOW_SECONDS,
    );
    // ...the second extends it to the full 30-minute lockout duration.
    expect(redisClient.expire).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      LOCKOUT_DURATION_SECONDS,
    );
  });

  it("emits a single security alert when the lockout begins", async () => {
    const limiter = new TwoFactorRateLimiter();
    const warnSpy = jest.spyOn(logger, "warn");

    for (let attempt = 0; attempt < MAX_ATTEMPTS + 2; attempt++) {
      await limiter.incrementFailures("admin-2");
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "security.2fa.account_lockout",
        userId: "admin-2",
        attempts: MAX_ATTEMPTS,
      }),
      expect.stringContaining("SECURITY ALERT"),
    );
  });

  it("resets the counter after a successful verification", async () => {
    const limiter = new TwoFactorRateLimiter();

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await limiter.incrementFailures("admin-3");
    }
    await limiter.resetFailures("admin-3");
    await limiter.incrementFailures("admin-3");

    expect(await limiter.isLocked("admin-3")).toBe(false);
    expect(await limiter.getRemainingTries("admin-3")).toBe(MAX_ATTEMPTS - 1);
  });
});

describe("TwoFactorRateLimiter lockout side effects (#2380)", () => {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryWrite.mockClear().mockResolvedValue({ rows: [], rowCount: 1 });
    mockSendAccountLockoutNotification.mockClear().mockResolvedValue(undefined);
    store.clear();
    ttls.clear();
    (redisClient.incr as jest.Mock).mockImplementation(async (key: unknown) => {
      const next = (store.get(String(key)) ?? 0) + 1;
      store.set(String(key), next);
      return next;
    });
    (redisClient.get as jest.Mock).mockImplementation(async (key: unknown) => {
      const value = store.get(String(key));
      return value === undefined ? null : String(value);
    });
    (redisClient.expire as jest.Mock).mockImplementation(
      async (key: unknown, seconds: unknown) => {
        ttls.set(String(key), Number(seconds));
        return true;
      },
    );
    (redisClient.ttl as jest.Mock).mockImplementation(
      async (key: unknown) => ttls.get(String(key)) ?? -2,
    );
    (redisClient.del as jest.Mock).mockImplementation(async (key: unknown) => {
      store.delete(String(key));
      ttls.delete(String(key));
      return 1;
    });
  });

  async function lockOut(limiter: TwoFactorRateLimiter, userId: string, email?: string) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await limiter.incrementFailures(userId, email);
    }
  }

  it("persists account_locked_until on the user row when the lockout begins", async () => {
    const limiter = new TwoFactorRateLimiter();
    await lockOut(limiter, "user-lock-1");

    expect(mockQueryWrite).toHaveBeenCalledWith(
      expect.stringContaining("account_locked_until = $1"),
      [expect.any(Date), "user-lock-1"],
    );
  });

  it("sets account_locked_until roughly 30 minutes in the future", async () => {
    const limiter = new TwoFactorRateLimiter();
    const before = Date.now();
    await lockOut(limiter, "user-lock-2");
    const after = Date.now();

    const [, params] = mockQueryWrite.mock.calls[0];
    const unlocksAt = (params as [Date, string])[0].getTime();

    expect(unlocksAt).toBeGreaterThanOrEqual(before + LOCKOUT_DURATION_SECONDS * 1000);
    expect(unlocksAt).toBeLessThanOrEqual(after + LOCKOUT_DURATION_SECONDS * 1000 + 1000);
  });

  it("sends an unlock-instructions email when the lockout begins and an email is provided", async () => {
    const limiter = new TwoFactorRateLimiter();
    await lockOut(limiter, "user-lock-3", "locked-out@example.com");

    expect(mockSendAccountLockoutNotification).toHaveBeenCalledTimes(1);
    const [to, options] = mockSendAccountLockoutNotification.mock.calls[0];
    expect(to).toBe("locked-out@example.com");
    expect(options).toMatchObject({
      minutesRemaining: LOCKOUT_DURATION_SECONDS / 60,
    });
    expect(options.unlocksAt).toBeInstanceOf(Date);
  });

  it("does not attempt to send an email when none is provided", async () => {
    const limiter = new TwoFactorRateLimiter();
    await lockOut(limiter, "user-lock-4");

    expect(mockSendAccountLockoutNotification).not.toHaveBeenCalled();
    // The DB side effect still applies even without an email.
    expect(mockQueryWrite).toHaveBeenCalled();
  });

  it("does not persist or email again on further attempts while already locked", async () => {
    const limiter = new TwoFactorRateLimiter();
    await lockOut(limiter, "user-lock-5", "locked-out@example.com");

    mockQueryWrite.mockClear();
    mockSendAccountLockoutNotification.mockClear();

    // Two more attempts made while already locked out.
    await limiter.incrementFailures("user-lock-5", "locked-out@example.com");
    await limiter.incrementFailures("user-lock-5", "locked-out@example.com");

    expect(mockQueryWrite).not.toHaveBeenCalled();
    expect(mockSendAccountLockoutNotification).not.toHaveBeenCalled();
  });

  it("clears account_locked_until when resetFailures runs after a successful verification", async () => {
    const limiter = new TwoFactorRateLimiter();
    await lockOut(limiter, "user-lock-6");
    mockQueryWrite.mockClear();

    await limiter.resetFailures("user-lock-6");

    expect(mockQueryWrite).toHaveBeenCalledWith(
      expect.stringContaining("account_locked_until = NULL"),
      ["user-lock-6"],
    );
  });

  it("does not fail the lockout when the DB write throws (best-effort)", async () => {
    mockQueryWrite.mockRejectedValueOnce(new Error("db unavailable"));
    const limiter = new TwoFactorRateLimiter();

    await expect(lockOut(limiter, "user-lock-7")).resolves.not.toThrow();
    expect(await limiter.isLocked("user-lock-7")).toBe(true);
  });

  it("does not fail the lockout when the email send throws (best-effort)", async () => {
    mockSendAccountLockoutNotification.mockRejectedValueOnce(
      new Error("sendgrid down"),
    );
    const limiter = new TwoFactorRateLimiter();

    await expect(
      lockOut(limiter, "user-lock-8", "locked-out@example.com"),
    ).resolves.not.toThrow();
    expect(await limiter.isLocked("user-lock-8")).toBe(true);
  });

  it("TTL expiry: the account auto-unlocks once the Redis key expires", async () => {
    const limiter = new TwoFactorRateLimiter();
    await lockOut(limiter, "user-lock-9");
    expect(await limiter.isLocked("user-lock-9")).toBe(true);

    // Simulate Redis TTL expiry by deleting the key, as Redis itself would.
    store.delete("2fa:lockout:user-lock-9");
    ttls.delete("2fa:lockout:user-lock-9");

    expect(await limiter.isLocked("user-lock-9")).toBe(false);
    expect(await limiter.getRemainingTries("user-lock-9")).toBe(MAX_ATTEMPTS);
  });
});
