import { cancelTransactionRateLimiter } from "../../src/middleware/rateLimit";
import { redisClient } from "../../src/config/redis";

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    isOpen: false,
    sendCommand: jest.fn(),
  },
}));

describe("cancelTransactionRateLimiter", () => {
  const mockRedisClient = redisClient as unknown as {
    isOpen: boolean;
    sendCommand: jest.Mock;
  };

  beforeEach(() => {
    mockRedisClient.isOpen = true;
    mockRedisClient.sendCommand.mockReset();
  });

  it("allows cancellations when under the hourly limit", async () => {
    mockRedisClient.sendCommand.mockResolvedValue(["1", "3", `${Date.now()}`]);

    const req = {
      jwtUser: { userId: "user-1" },
      path: "/api/v1/transactions/txn-1/cancel",
      method: "POST",
    } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    } as any;
    const next = jest.fn();

    await cancelTransactionRateLimiter(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", "5");
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", "2");
  });

  it("rejects cancellations when the hourly limit is exceeded", async () => {
    const oldest = Date.now() - 5 * 60 * 1000;
    mockRedisClient.sendCommand.mockResolvedValue(["0", "5", String(oldest)]);

    const req = {
      jwtUser: { userId: "user-1" },
      path: "/api/v1/transactions/txn-1/cancel",
      method: "POST",
    } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    } as any;
    const next = jest.fn();

    await cancelTransactionRateLimiter(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: "Too Many Requests",
      message: expect.stringContaining("Too many transaction cancellation requests"),
    }));
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  it("passes through when Redis is unavailable", async () => {
    mockRedisClient.isOpen = false;

    const req = {
      jwtUser: { userId: "user-1" },
      path: "/api/v1/transactions/txn-1/cancel",
      method: "POST",
    } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    } as any;
    const next = jest.fn();

    await cancelTransactionRateLimiter(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
