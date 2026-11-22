import { Request, Response, NextFunction } from "express";
import { slidingRateLimiter } from "../../src/middleware/slidingRateLimiter";
import { redisClient } from "../../src/config/redis";

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    multi: jest.fn(),
  },
}));

describe("slidingRateLimiter", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let mockMulti: any;

  beforeEach(() => {
    mockReq = {
      ip: "127.0.0.1",
      path: "/prices",
      baseUrl: "/sep38",
      headers: {},
      connection: { remoteAddress: "127.0.0.1" } as any,
    };
    mockRes = {
      setHeader: jest.fn(),
    };
    mockNext = jest.fn();

    mockMulti = {
      zRemRangeByScore: jest.fn().mockReturnThis(),
      zAdd: jest.fn().mockReturnThis(),
      zCard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([0, 1, 1, true]), // currentCount is 1
    };
    
    (redisClient.multi as jest.Mock).mockReturnValue(mockMulti);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should allow anonymous request below limit and set headers", async () => {
    const middleware = slidingRateLimiter({
      windowMs: 60000,
      anonymousLimit: 60,
      authenticatedLimit: 600,
    });

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockMulti.zRemRangeByScore).toHaveBeenCalled();
    expect(mockMulti.zAdd).toHaveBeenCalled();
    expect(mockMulti.zCard).toHaveBeenCalled();
    expect(mockMulti.expire).toHaveBeenCalled();
    expect(mockMulti.exec).toHaveBeenCalled();

    expect(mockRes.setHeader).toHaveBeenCalledWith("RateLimit-Limit", 60);
    expect(mockRes.setHeader).toHaveBeenCalledWith("RateLimit-Remaining", 59);
    expect(mockRes.setHeader).toHaveBeenCalledWith(
      "RateLimit-Reset",
      expect.any(Number)
    );
    expect(mockNext).toHaveBeenCalledWith();
  });

  it("should block anonymous request above limit", async () => {
    mockMulti.exec.mockResolvedValue([0, 1, 61, true]); // currentCount is 61 (above 60)

    const middleware = slidingRateLimiter({
      windowMs: 60000,
      anonymousLimit: 60,
      authenticatedLimit: 600,
    });

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockRes.setHeader).toHaveBeenCalledWith("RateLimit-Limit", 60);
    expect(mockRes.setHeader).toHaveBeenCalledWith("RateLimit-Remaining", 0);
    expect(mockNext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Too many requests, please try again later.",
      })
    );
  });

  it("should allow authenticated request up to authenticated limit", async () => {
    mockReq.headers!["x-api-key"] = "secret-key";
    mockMulti.exec.mockResolvedValue([0, 1, 300, true]); // currentCount is 300 (below 600, but above 60)

    const middleware = slidingRateLimiter({
      windowMs: 60000,
      anonymousLimit: 60,
      authenticatedLimit: 600,
    });

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockRes.setHeader).toHaveBeenCalledWith("RateLimit-Limit", 600);
    expect(mockRes.setHeader).toHaveBeenCalledWith("RateLimit-Remaining", 300);
    expect(mockNext).toHaveBeenCalledWith();
  });

  it("should fail open if redis throws error", async () => {
    mockMulti.exec.mockRejectedValue(new Error("Redis offline"));

    const middleware = slidingRateLimiter({
      windowMs: 60000,
      anonymousLimit: 60,
      authenticatedLimit: 600,
    });

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalledWith();
  });
});
