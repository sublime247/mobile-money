import { Request, Response } from "express";
import {
  RATE_LIMIT_CONFIG,
  apiKeyAndIpRateLimiter,
} from "../rateLimit";
import { redisClient } from "../../config/redis";

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    incr: jest.fn(),
    pexpire: jest.fn(),
    sendCommand: jest.fn(),
  },
}));

const mockRedisClient = redisClient as unknown as {
  isOpen: boolean;
  incr: jest.Mock;
  pexpire: jest.Mock;
};

function buildReq(opts: { apiKey?: string; ip?: string } = {}): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === "x-api-key" ? opts.apiKey : undefined,
    ip: opts.ip ?? "203.0.113.10",
    socket: { remoteAddress: opts.ip ?? "203.0.113.10" },
    path: "/api/v1/transactions",
    method: "GET",
  } as unknown as Request;
}

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

describe("apiKeyAndIpRateLimiter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient.isOpen = true;
  });

  it("allows a request under both the IP and API key limits", async () => {
    mockRedisClient.incr.mockResolvedValue(1);
    mockRedisClient.pexpire.mockResolvedValue(1);

    const req = buildReq({ apiKey: "test-key-123" });
    const res = buildRes();
    const next = jest.fn();

    await apiKeyAndIpRateLimiter(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("checks the IP limit even when no API key header is present", async () => {
    mockRedisClient.incr.mockResolvedValue(1);
    mockRedisClient.pexpire.mockResolvedValue(1);

    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await apiKeyAndIpRateLimiter(req, res, next);

    expect(mockRedisClient.incr).toHaveBeenCalledWith(
      expect.stringContaining("API_IP"),
    );
    expect(next).toHaveBeenCalled();
  });

  it("rejects with 429 when the IP limit is exceeded, before checking the API key", async () => {
    mockRedisClient.incr.mockResolvedValue(RATE_LIMIT_CONFIG.IP_LIMIT + 1);
    mockRedisClient.pexpire.mockResolvedValue(1);

    const req = buildReq({ apiKey: "test-key-123" });
    const res = buildRes();
    const next = jest.fn();

    await apiKeyAndIpRateLimiter(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Rate limit exceeded for this IP address",
      }),
    );
  });

  it("rejects with 429 when the API key limit is exceeded but IP limit is fine", async () => {
    mockRedisClient.incr.mockImplementation((key: string) =>
      Promise.resolve(
        key.includes("API_KEY") ? RATE_LIMIT_CONFIG.API_KEY_LIMIT + 1 : 1,
      ),
    );
    mockRedisClient.pexpire.mockResolvedValue(1);

    const req = buildReq({ apiKey: "test-key-123" });
    const res = buildRes();
    const next = jest.fn();

    await apiKeyAndIpRateLimiter(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Rate limit exceeded for this API key",
      }),
    );
  });

  it("sets X-RateLimit-* headers only when an API key is present", async () => {
    mockRedisClient.incr.mockResolvedValue(1);
    mockRedisClient.pexpire.mockResolvedValue(1);

    const reqWithoutKey = buildReq();
    const resWithoutKey = buildRes();
    await apiKeyAndIpRateLimiter(reqWithoutKey, resWithoutKey, jest.fn());
    expect(resWithoutKey.setHeader).not.toHaveBeenCalledWith(
      "X-RateLimit-Limit",
      expect.anything(),
    );

    const reqWithKey = buildReq({ apiKey: "test-key-123" });
    const resWithKey = buildRes();
    await apiKeyAndIpRateLimiter(reqWithKey, resWithKey, jest.fn());
    expect(resWithKey.setHeader).toHaveBeenCalledWith(
      "X-RateLimit-Limit",
      RATE_LIMIT_CONFIG.API_KEY_LIMIT,
    );
  });

  it("falls back to the socket remote address when req.ip is unavailable", async () => {
    mockRedisClient.incr.mockResolvedValue(1);
    mockRedisClient.pexpire.mockResolvedValue(1);

    const req = {
      header: () => undefined,
      ip: undefined,
      socket: { remoteAddress: "198.51.100.5" },
      path: "/api/v1/transactions",
      method: "GET",
    } as unknown as Request;
    const res = buildRes();
    const next = jest.fn();

    await apiKeyAndIpRateLimiter(req, res, next);

    expect(mockRedisClient.incr).toHaveBeenCalledWith(
      expect.stringContaining("198.51.100.5"),
    );
    expect(next).toHaveBeenCalled();
  });
});
