import { queryRead, queryWrite } from "../config/database";
import type { LocationMetadata } from "../services/geolocation";

export interface UserSessionRow {
  id: string;
  user_id: string;
  fingerprint: string;
  ip_address: string | null;
  country: string | null;
  country_code: string | null;
  city: string | null;
  isp: string | null;
  lat: number | null;
  lon: number | null;
  user_agent: string | null;
  is_active: boolean;
  last_seen_at: Date | string;
  created_at: Date | string;
  revoked_at: Date | string | null;
}

export interface UserSession {
  id: string;
  userId: string;
  fingerprint: string;
  ipAddress: string | null;
  location: LocationMetadata | null;
  userAgent: string | null;
  isActive: boolean;
  lastSeenAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
}

export class UserSessionModel {
  async createSession(data: {
    userId: string;
    fingerprint: string;
    ipAddress: string | null;
    location: LocationMetadata;
    userAgent: string | null;
  }): Promise<UserSession> {
    const res = await queryWrite<UserSessionRow>(
      `INSERT INTO user_sessions
        (user_id, fingerprint, ip_address, country, country_code, city, isp, lat, lon, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        data.userId,
        data.fingerprint,
        data.ipAddress,
        data.location.country,
        data.location.countryCode,
        data.location.city,
        data.location.isp,
        data.location.lat,
        data.location.lon,
        data.userAgent,
      ],
    );
    return this.mapRow(res.rows[0]);
  }

  async getActiveSessionsForUser(userId: string): Promise<UserSession[]> {
    const res = await queryRead<UserSessionRow>(
      `SELECT * FROM user_sessions
       WHERE user_id = $1 AND is_active = true
       ORDER BY last_seen_at DESC`,
      [userId],
    );
    return res.rows.map(this.mapRow);
  }

  async touchLastSeen(sessionId: string): Promise<void> {
    await queryWrite(
      `UPDATE user_sessions SET last_seen_at = NOW() WHERE id = $1 AND is_active = true`,
      [sessionId],
    );
  }

  async revokeSession(sessionId: string, userId: string): Promise<boolean> {
    const res = await queryWrite(
      `UPDATE user_sessions
       SET is_active = false, revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND is_active = true`,
      [sessionId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private mapRow(row: UserSessionRow): UserSession {
    const hasLocation = row.country !== null || row.city !== null;
    return {
      id: row.id,
      userId: row.user_id,
      fingerprint: row.fingerprint,
      ipAddress: row.ip_address,
      location: hasLocation
        ? {
            country: row.country ?? "Unknown",
            countryCode: row.country_code ?? "XX",
            city: row.city ?? "Unknown",
            isp: row.isp ?? "Unknown",
            lat: row.lat ?? 0,
            lon: row.lon ?? 0,
            status: "resolved",
          }
        : null,
      userAgent: row.user_agent,
      isActive: row.is_active,
      lastSeenAt: new Date(row.last_seen_at),
      createdAt: new Date(row.created_at),
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    };
  }
}

export const userSessionModel = new UserSessionModel();
