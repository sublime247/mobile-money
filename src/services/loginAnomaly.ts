import geoip from "geoip-lite";
import type { Request } from "express";
import { redisClient } from "../config/redis";
import { User } from "./userService";

export interface LoginAnomalyResult {
  suspicious: boolean;
  requiresStepUp: boolean;
  reason?: string;
  previousIp?: string;
  currentIp?: string;
  previousCountry?: string;
  currentCountry?: string;
}

const ADMIN_LOGIN_IP_KEY = (userId: string) => `admin:last_login_ip:${userId}`;
const ADMIN_LOGIN_AT_KEY = (userId: string) => `admin:last_login_at:${userId}`;
const ADMIN_LOGIN_TTL_SECONDS = 30 * 24 * 60 * 60;

export function normalizeIpAddress(
  value: string | undefined | null,
): string | null {
  if (!value) return null;

  const first = value.split(",")[0]?.trim();
  if (!first) return null;

  return first.startsWith("::ffff:") ? first.slice(7) : first;
}

export function getCurrentRequestIp(
  req: Pick<Request, "headers" | "ip">,
): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return normalizeIpAddress(forwardedValue ?? req.ip);
}

export function getIpLocation(ip: string): string | null {
  const geo = geoip.lookup(ip);
  if (!geo || !geo.country) return null;

  const parts = [geo.country, geo.region, geo.city].filter(Boolean);
  return parts.join(", ");
}

export function isAdminRole(role?: string): boolean {
  return role === "admin" || role === "super-admin";
}

export async function evaluateAdminLoginAnomaly(
  req: Request,
  user: User,
): Promise<LoginAnomalyResult> {
  const currentIp = getCurrentRequestIp(req);
  if (!currentIp || !isAdminRole(user.role_name)) {
    return {
      suspicious: false,
      requiresStepUp: false,
      currentIp: currentIp ?? undefined,
    };
  }

  const previousIpRaw = await redisClient.get(ADMIN_LOGIN_IP_KEY(user.id));
  const previousAtValue = await redisClient.get(ADMIN_LOGIN_AT_KEY(user.id));
  const currentCountry = getIpLocation(currentIp);
  const previousIp = previousIpRaw ? String(previousIpRaw) : null;
  const previousCountry = previousIp ? getIpLocation(previousIp) : null;
  const lastLoginTs = previousAtValue ? Number(previousAtValue) : null;
  const timeSinceLastLoginMs = lastLoginTs ? Date.now() - lastLoginTs : null;

  const rapidIpChange =
    typeof previousIp === "string" &&
    previousIp !== currentIp &&
    typeof timeSinceLastLoginMs === "number" &&
    timeSinceLastLoginMs < 5 * 60 * 1000;

  const locationChange =
    typeof previousIp === "string" &&
    previousIp !== currentIp &&
    previousCountry &&
    currentCountry &&
    previousCountry !== currentCountry;

  const suspicious = Boolean(
    previousIp && previousIp !== currentIp && (rapidIpChange || locationChange),
  );
  const reason = locationChange
    ? "admin_login_location_change"
    : rapidIpChange
      ? "admin_login_rapid_ip_change"
      : undefined;

  await redisClient.set(ADMIN_LOGIN_IP_KEY(user.id), currentIp, {
    EX: ADMIN_LOGIN_TTL_SECONDS,
  });
  await redisClient.set(ADMIN_LOGIN_AT_KEY(user.id), String(Date.now()), {
    EX: ADMIN_LOGIN_TTL_SECONDS,
  });

  if (suspicious) {
    console.warn(
      JSON.stringify({
        event: "admin_login_anomaly",
        userId: user.id,
        previousIp,
        currentIp,
        previousCountry,
        currentCountry,
        reason,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return {
    suspicious,
    requiresStepUp: suspicious,
    reason,
    previousIp: previousIp ?? undefined,
    currentIp,
    previousCountry: previousCountry ?? undefined,
    currentCountry: currentCountry ?? undefined,
  };
}
