import axios from "axios";
import {
  GeolocationService,
  anonymizeIp,
  isRoutableIp,
  UNKNOWN_LOCATION,
} from "../../src/services/geolocation";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock redis client — treat as disconnected so in-memory cache is used
jest.mock("../../src/config/redis", () => ({
  redisClient: { isOpen: false },
}));

describe("anonymizeIp", () => {
  it("zeros last IPv4 octet", () => {
    expect(anonymizeIp("203.0.113.45")).toBe("203.0.113.0");
  });

  it("truncates IPv6 to first 3 groups", () => {
    expect(anonymizeIp("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:85a3::");
  });

  it("returns empty string for empty input", () => {
    expect(anonymizeIp("")).toBe("");
  });
});

describe("isRoutableIp", () => {
  it("accepts a public IPv4", () => {
    expect(isRoutableIp("8.8.8.8")).toBe(true);
  });

  it("rejects loopback", () => {
    expect(isRoutableIp("127.0.0.1")).toBe(false);
  });

  it("rejects RFC-1918 10.x", () => {
    expect(isRoutableIp("10.0.0.1")).toBe(false);
  });

  it("rejects RFC-1918 192.168.x", () => {
    expect(isRoutableIp("192.168.1.1")).toBe(false);
  });

  it("rejects RFC-1918 172.16-31.x", () => {
    expect(isRoutableIp("172.16.0.1")).toBe(false);
    expect(isRoutableIp("172.31.255.255")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isRoutableIp("")).toBe(false);
  });
});

describe("GeolocationService", () => {
  let service: GeolocationService;

  beforeEach(() => {
    service = new GeolocationService();
    jest.clearAllMocks();
  });

  it("returns resolved location for a valid public IP", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        status: "success",
        country: "United States",
        countryCode: "US",
        city: "Mountain View",
        isp: "Google LLC",
      },
    });

    const result = await service.lookup("8.8.8.8");

    expect(result.status).toBe("resolved");
    expect(result.country).toBe("United States");
    expect(result.countryCode).toBe("US");
    expect(result.city).toBe("Mountain View");
    expect(result.isp).toBe("Google LLC");
  });

  it("returns UNKNOWN_LOCATION for a private IP without calling the API", async () => {
    mockedAxios.get = jest.fn();

    const result = await service.lookup("192.168.1.100");

    expect(result).toMatchObject(UNKNOWN_LOCATION);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("returns UNKNOWN_LOCATION when the API returns non-success status", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: { status: "fail", message: "invalid query" },
    });

    const result = await service.lookup("8.8.8.8");

    expect(result).toMatchObject(UNKNOWN_LOCATION);
  });

  it("returns UNKNOWN_LOCATION when the API throws (network error)", async () => {
    mockedAxios.get = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await service.lookup("8.8.8.8");

    expect(result).toMatchObject(UNKNOWN_LOCATION);
  });

  it("returns UNKNOWN_LOCATION when the API times out", async () => {
    mockedAxios.get = jest
      .fn()
      .mockRejectedValue(new Error("timeout of 3000ms exceeded"));

    const result = await service.lookup("8.8.8.8");

    expect(result).toMatchObject(UNKNOWN_LOCATION);
  });

  it("returns UNKNOWN_LOCATION for an empty IP string", async () => {
    mockedAxios.get = jest.fn();

    const result = await service.lookup("");

    expect(result).toMatchObject(UNKNOWN_LOCATION);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("uses in-memory cache on second call for the same IP", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        status: "success",
        country: "Germany",
        countryCode: "DE",
        city: "Berlin",
        isp: "Deutsche Telekom",
      },
    });

    await service.lookup("203.0.113.1");
    await service.lookup("203.0.113.1"); // same anonymized key → cache hit

    // API should only be called once
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("handles invalid IP format without throwing", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: { status: "fail", message: "invalid query" },
    });

    await expect(service.lookup("not-an-ip")).resolves.toMatchObject(
      UNKNOWN_LOCATION,
    );
  });
});
