const mockLookup = jest.fn();
const mockCreateSession = jest.fn();

jest.mock("../geolocation", () => ({
  geolocationService: { lookup: (...args: unknown[]) => mockLookup(...args) },
}));

jest.mock("../../models/userSession", () => ({
  userSessionModel: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
  },
}));

import { trackLoginSession } from "../userSessionTracking";
import type { LocationMetadata } from "../geolocation";

describe("trackLoginSession", () => {
  const location: LocationMetadata = {
    country: "Nigeria",
    countryCode: "NG",
    city: "Lagos",
    isp: "MTN",
    lat: 6.5244,
    lon: 3.3792,
    status: "resolved",
  };

  beforeEach(() => {
    mockLookup.mockReset();
    mockCreateSession.mockReset();
  });

  it("resolves the IP's location and persists a session record", async () => {
    mockLookup.mockResolvedValueOnce(location);
    mockCreateSession.mockResolvedValueOnce({
      id: "session-1",
      userId: "user-1",
      fingerprint: "abc123",
      ipAddress: "203.0.113.5",
      location,
      userAgent: "Mozilla/5.0",
      isActive: true,
      lastSeenAt: new Date(),
      createdAt: new Date(),
      revokedAt: null,
    });

    const result = await trackLoginSession({
      userId: "user-1",
      fingerprint: "abc123",
      ipAddress: "203.0.113.5",
      userAgent: "Mozilla/5.0",
    });

    expect(mockLookup).toHaveBeenCalledWith("203.0.113.5");
    expect(mockCreateSession).toHaveBeenCalledWith({
      userId: "user-1",
      fingerprint: "abc123",
      ipAddress: "203.0.113.5",
      location,
      userAgent: "Mozilla/5.0",
    });
    expect(result?.id).toBe("session-1");
  });

  it("passes an empty string to the geolocation lookup when ipAddress is null", async () => {
    mockLookup.mockResolvedValueOnce(location);
    mockCreateSession.mockResolvedValueOnce({});

    await trackLoginSession({
      userId: "user-1",
      fingerprint: "abc123",
      ipAddress: null,
      userAgent: null,
    });

    expect(mockLookup).toHaveBeenCalledWith("");
  });

  it("returns null and does not throw when the geolocation lookup fails", async () => {
    mockLookup.mockRejectedValueOnce(new Error("geo API down"));

    const result = await trackLoginSession({
      userId: "user-1",
      fingerprint: "abc123",
      ipAddress: "203.0.113.5",
      userAgent: null,
    });

    expect(result).toBeNull();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("returns null and does not throw when persisting the session fails", async () => {
    mockLookup.mockResolvedValueOnce(location);
    mockCreateSession.mockRejectedValueOnce(new Error("db down"));

    const result = await trackLoginSession({
      userId: "user-1",
      fingerprint: "abc123",
      ipAddress: "203.0.113.5",
      userAgent: null,
    });

    expect(result).toBeNull();
  });
});
