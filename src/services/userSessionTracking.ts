import logger from "../utils/logger";
import { geolocationService } from "./geolocation";
import { userSessionModel, UserSession } from "../models/userSession";

/**
 * Records a session for a successful login: resolves the request IP to a
 * location via GeolocationService and persists a user_sessions row with the
 * device fingerprint, IP, and location metadata.
 *
 * Best-effort — a failure here must never block login. Returns null (and
 * logs) instead of throwing.
 */
export async function trackLoginSession(params: {
  userId: string;
  fingerprint: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<UserSession | null> {
  try {
    const location = await geolocationService.lookup(params.ipAddress ?? "");

    return await userSessionModel.createSession({
      userId: params.userId,
      fingerprint: params.fingerprint,
      ipAddress: params.ipAddress,
      location,
      userAgent: params.userAgent,
    });
  } catch (err) {
    logger.error(
      { err, userId: params.userId },
      "[user-session-tracking] Failed to record login session",
    );
    return null;
  }
}
