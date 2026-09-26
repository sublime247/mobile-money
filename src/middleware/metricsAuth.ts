import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export interface MetricsAuthOptions {
  authEnabled?: boolean;
  username?: string;
  password?: string;
  internalOnly?: boolean;
  allowedIps?: string[];
}

/**
 * Checks if an IP is a local or private address (loopback or private RFC 1918 / IPv6 local)
 */
export function isPrivateOrLocalIp(ip: string): boolean {
  if (!ip) return false;
  // Normalize IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1)
  const cleanIp = ip.replace(/^::ffff:/, "").trim();

  // Loopback addresses
  if (
    cleanIp === "127.0.0.1" ||
    cleanIp === "::1" ||
    cleanIp === "localhost" ||
    cleanIp === "0.0.0.0"
  ) {
    return true;
  }

  // IPv4 private ranges:
  // 10.0.0.0/8
  // 172.16.0.0/12
  // 192.168.0.0/16
  const parts = cleanIp.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
  }

  return false;
}

/**
 * Extracts client IP from request headers and socket
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw.split(",")[0].trim();
    if (first) return first;
  }
  return (
    req.ip ||
    req.socket?.remoteAddress ||
    (req.connection as any)?.remoteAddress ||
    ""
  );
}

/**
 * Creates authentication and internal network restriction middleware for /metrics endpoint.
 */
export const createMetricsAuthMiddleware = (options: MetricsAuthOptions = {}) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authEnabled =
      options.authEnabled ??
      (process.env.METRICS_AUTH_ENABLED === "true" ||
        Boolean(process.env.METRICS_USER || process.env.METRICS_PASSWORD));

    const internalOnly =
      options.internalOnly ??
      (process.env.METRICS_INTERNAL_ONLY === "true");

    const expectedUser =
      options.username ?? process.env.METRICS_USER ?? "metrics";
    const expectedPassword =
      options.password ?? process.env.METRICS_PASSWORD ?? "metrics";

    const allowedIps =
      options.allowedIps ??
      (process.env.METRICS_ALLOWED_IPS
        ? process.env.METRICS_ALLOWED_IPS.split(",").map((s) => s.trim())
        : []);

    // 1. Check IP restriction if internalOnly is true or allowedIps is specified
    if (internalOnly || allowedIps.length > 0) {
      const clientIp = getClientIp(req);
      const normalizedClientIp = clientIp.replace(/^::ffff:/, "").trim();

      const isAllowedExplicitly = allowedIps.some((allowed) => {
        const cleanAllowed = allowed.replace(/^::ffff:/, "").trim();
        return cleanAllowed === normalizedClientIp || cleanAllowed === clientIp;
      });

      const isAllowedInternal = internalOnly && isPrivateOrLocalIp(clientIp);

      if (!isAllowedExplicitly && !isAllowedInternal) {
        res.status(403).json({
          error: "Forbidden: Access to /metrics is restricted to internal network",
        });
        return;
      }
    }

    // 2. Check HTTP Basic Authentication if enabled
    if (authEnabled) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Basic ")) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Prometheus Metrics"');
        res.status(401).json({
          error: "Unauthorized: Metrics endpoint requires Basic authentication",
        });
        return;
      }

      const credentialsBase64 = authHeader.slice(6).trim();
      const credentials = Buffer.from(credentialsBase64, "base64").toString("utf-8");
      const colonIndex = credentials.indexOf(":");

      if (colonIndex === -1) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Prometheus Metrics"');
        res.status(401).json({
          error: "Unauthorized: Invalid metrics credentials format",
        });
        return;
      }

      const username = credentials.substring(0, colonIndex);
      const password = credentials.substring(colonIndex + 1);

      const usernameBuf = Buffer.from(username);
      const expectedUserBuf = Buffer.from(expectedUser);
      const passwordBuf = Buffer.from(password);
      const expectedPasswordBuf = Buffer.from(expectedPassword);

      const usernameMatch =
        usernameBuf.length === expectedUserBuf.length &&
        crypto.timingSafeEqual(usernameBuf, expectedUserBuf);
      const passwordMatch =
        passwordBuf.length === expectedPasswordBuf.length &&
        crypto.timingSafeEqual(passwordBuf, expectedPasswordBuf);

      if (!usernameMatch || !passwordMatch) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Prometheus Metrics"');
        res.status(401).json({
          error: "Unauthorized: Invalid metrics credentials",
        });
        return;
      }
    }

    next();
  };
};
