const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();

jest.mock("../../config/database", () => ({
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
}));

import { UserSessionModel, UserSessionRow } from "../userSession";
import type { LocationMetadata } from "../../services/geolocation";

describe("UserSessionModel", () => {
  const model = new UserSessionModel();

  const location: LocationMetadata = {
    country: "Nigeria",
    countryCode: "NG",
    city: "Lagos",
    isp: "MTN",
    lat: 6.5244,
    lon: 3.3792,
    status: "resolved",
  };

  const row: UserSessionRow = {
    id: "session-1",
    user_id: "user-1",
    fingerprint: "abc123",
    ip_address: "203.0.113.5",
    country: "Nigeria",
    country_code: "NG",
    city: "Lagos",
    isp: "MTN",
    lat: 6.5244,
    lon: 3.3792,
    user_agent: "Mozilla/5.0",
    is_active: true,
    last_seen_at: new Date("2026-08-27T10:00:00.000Z"),
    created_at: new Date("2026-08-27T09:00:00.000Z"),
    revoked_at: null,
  };

  beforeEach(() => {
    mockQueryRead.mockReset();
    mockQueryWrite.mockReset();
  });

  describe("createSession", () => {
    it("inserts a session row with location fields and maps it back", async () => {
      mockQueryWrite.mockResolvedValueOnce({ rows: [row] });

      const result = await model.createSession({
        userId: "user-1",
        fingerprint: "abc123",
        ipAddress: "203.0.113.5",
        location,
        userAgent: "Mozilla/5.0",
      });

      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO user_sessions"),
        [
          "user-1",
          "abc123",
          "203.0.113.5",
          "Nigeria",
          "NG",
          "Lagos",
          "MTN",
          6.5244,
          3.3792,
          "Mozilla/5.0",
        ],
      );

      expect(result.id).toBe("session-1");
      expect(result.location).toEqual(location);
      expect(result.isActive).toBe(true);
    });
  });

  describe("getActiveSessionsForUser", () => {
    it("returns only active sessions ordered by most recent", async () => {
      mockQueryRead.mockResolvedValueOnce({ rows: [row] });

      const sessions = await model.getActiveSessionsForUser("user-1");

      expect(mockQueryRead).toHaveBeenCalledWith(
        expect.stringContaining("is_active = true"),
        ["user-1"],
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].userId).toBe("user-1");
    });

    it("returns an empty array when there are no active sessions", async () => {
      mockQueryRead.mockResolvedValueOnce({ rows: [] });
      const sessions = await model.getActiveSessionsForUser("user-1");
      expect(sessions).toEqual([]);
    });

    it("maps a null location to null instead of a fabricated Unknown object", async () => {
      mockQueryRead.mockResolvedValueOnce({
        rows: [{ ...row, country: null, city: null, country_code: null, isp: null, lat: null, lon: null }],
      });
      const sessions = await model.getActiveSessionsForUser("user-1");
      expect(sessions[0].location).toBeNull();
    });
  });

  describe("revokeSession", () => {
    it("returns true when a row was revoked", async () => {
      mockQueryWrite.mockResolvedValueOnce({ rowCount: 1 });
      const result = await model.revokeSession("session-1", "user-1");
      expect(result).toBe(true);
      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE user_sessions"),
        ["session-1", "user-1"],
      );
    });

    it("returns false when no row matched (wrong owner or already revoked)", async () => {
      mockQueryWrite.mockResolvedValueOnce({ rowCount: 0 });
      const result = await model.revokeSession("session-1", "user-1");
      expect(result).toBe(false);
    });
  });

  describe("touchLastSeen", () => {
    it("issues an UPDATE scoped to the active session", async () => {
      mockQueryWrite.mockResolvedValueOnce({ rowCount: 1 });
      await model.touchLastSeen("session-1");
      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE user_sessions SET last_seen_at"),
        ["session-1"],
      );
    });
  });
});
