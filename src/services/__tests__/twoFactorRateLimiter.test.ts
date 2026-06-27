import { jest } from "@jest/globals";
import { redisClient } from "../../config/redis";
import { TwoFactorRateLimiter } from "../twoFactorRateLimiter";

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

    getMock.mockResolvedValue("3");
    ttlMock.mockResolvedValue(600);

    const headers = await limiter.getRateLimitHeaders("user-123");

    expect(headers).toMatchObject({
      limit: 3,
      remaining: 0,
      retryAfter: 600,
    });
    expect(headers.resetAt).toContain("T");
  });
});
