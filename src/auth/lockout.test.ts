import {
  getLockoutStatus,
  recordFailedAttempt,
  recordSuccessfulLogin,
} from "./lockout";
import { redisClient } from "../config/redis";

jest.mock("../config/redis", () => ({
  redisClient: {
    ttl: jest.fn(),
    get: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  },
}));

const mockedRedis = redisClient as unknown as {
  ttl: jest.Mock;
  get: jest.Mock;
  incr: jest.Mock;
  expire: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};

describe("auth lockout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRedis.ttl.mockResolvedValue(-1);
    mockedRedis.get.mockResolvedValue(null);
  });

  it("locks account after 5 failed attempts in 10 minutes", async () => {
    mockedRedis.incr
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5);

    for (let i = 0; i < 4; i += 1) {
      const result = await recordFailedAttempt("+123456789");
      expect(result.isLocked).toBe(false);
    }

    const locked = await recordFailedAttempt("+123456789");

    expect(locked.isLocked).toBe(true);
    expect(locked.justLocked).toBe(true);
    expect(mockedRedis.expire).toHaveBeenCalledWith(
      "auth:login:attempts:+123456789",
      600,
    );
    expect(mockedRedis.set).toHaveBeenCalledWith(
      "auth:login:lock:+123456789",
      "1",
      { EX: 600 },
    );
  });

  it("returns locked status with minutes remaining", async () => {
    mockedRedis.ttl.mockResolvedValue(301);

    const status = await getLockoutStatus("+15550000000");

    expect(status.isLocked).toBe(true);
    expect(status.minutesRemaining).toBe(6);
    expect(status.attemptsRemaining).toBe(0);
  });

  it("clears lockout state on successful login", async () => {
    await recordSuccessfulLogin("+19990000000");

    expect(mockedRedis.del).toHaveBeenCalledWith(
      ["auth:login:attempts:+19990000000", "auth:login:lock:+19990000000"],
    );
  });
});
