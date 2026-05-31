import { layeredCache } from "../../src/services/layeredCache";
import { redisClient } from "../../src/config/redis";

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
    publish: jest.fn(),
    isOpen: true,
  },
}));

describe("LayeredCache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return from L1 on second call (hit)", async () => {
    const key = "test-key";
    const value = { foo: "bar" };

    (redisClient.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(value));

    // First call: L1 miss, L2 hit
    const res1 = await layeredCache.get(key);
    expect(res1).toEqual(value);
    expect(redisClient.get).toHaveBeenCalledTimes(1);

    // Second call: L1 hit
    const res2 = await layeredCache.get(key);
    expect(res2).toEqual(value);
    expect(redisClient.get).toHaveBeenCalledTimes(1); // Should not call Redis again
  });

  it("should propagate invalidation to L1", async () => {
    const key = "test-key";
    const value = { foo: "bar" };

    await layeredCache.set(key, value, 60);

    // Verify it's in L1
    const res1 = await layeredCache.get(key);
    expect(res1).toEqual(value);
    expect(redisClient.get).not.toHaveBeenCalled();

    // Invalidate
    await layeredCache.del(key);
    expect(redisClient.del).toHaveBeenCalledWith(key);
    expect(redisClient.publish).toHaveBeenCalled();

    // Next get should call Redis (L1 miss)
    (redisClient.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(value));
    const res2 = await layeredCache.get(key);
    expect(res2).toEqual(value);
    expect(redisClient.get).toHaveBeenCalled();
  });
});
