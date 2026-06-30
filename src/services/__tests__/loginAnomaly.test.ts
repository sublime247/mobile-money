import {
  evaluateAdminLoginAnomaly,
  getCurrentRequestIp,
} from "../loginAnomaly";
import { redisClient } from "../../config/redis";

type RedisMock = {
  get: jest.Mock<Promise<string | null>, [string]>;
  set: jest.Mock<Promise<unknown>, [string, string, { EX: number }]>;
};

jest.mock("../../config/redis", () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

describe("Admin login anomaly detection", () => {
  const mockedRedisClient = redisClient as unknown as RedisMock;

  beforeEach(() => {
    mockedRedisClient.get.mockReset();
    mockedRedisClient.set.mockReset();
  });

  it("flags rapid admin IP changes and persists login state", async () => {
    mockedRedisClient.get.mockImplementation(async (key: string) => {
      if (key.includes("last_login_ip")) return "1.1.1.1";
      if (key.includes("last_login_at")) return String(Date.now() - 60 * 1000);
      return null;
    });

    const result = await evaluateAdminLoginAnomaly(
      {
        headers: { "x-forwarded-for": "2.2.2.2" },
        ip: "2.2.2.2",
      } as any,
      {
        id: "admin-1",
        role_name: "admin",
        two_factor_secret: "SECRET",
        two_factor_enabled: true,
        two_factor_verified: true,
      } as any,
    );

    expect(result.suspicious).toBe(true);
    expect(result.reason).toBe("admin_login_location_change");
    expect(mockedRedisClient.set).toHaveBeenCalledWith(
      "admin:last_login_ip:admin-1",
      "2.2.2.2",
      { EX: 2592000 },
    );
  });
});

describe("getCurrentRequestIp", () => {
  it("prefers x-forwarded-for over the direct request IP", () => {
    expect(
      getCurrentRequestIp({
        headers: { "x-forwarded-for": "::ffff:2.2.2.2, 3.3.3.3" },
        ip: "::1",
      } as any),
    ).toBe("2.2.2.2");
  });
});
