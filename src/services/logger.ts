import { NextFunction, Request, Response } from "express";
declare module "express-session" {
  interface SessionData {
    sessionIp?: string;
    suspicious?: boolean;
    suspiciousReason?: string;
    sessionIpMismatchCount?: number;
    lastSessionAnomalyAt?: string;
  }
}

export interface SessionAnomalyAuditEvent {
  event: "session.ip_mismatch";
  timestamp: string;
  sessionId: string;
  method: string;
  path: string;
  previousIp: string;
  currentIp: string;
  suspicious: true;
  mismatchCount: number;
  userAgent?: string;
}

function loggedPath(req: Request): string {
  const raw = req.originalUrl ?? req.url ?? "/";
  const q = raw.indexOf("?");
  return (q >= 0 ? raw.slice(0, q) : raw) || "/";
}

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

export function buildSessionAnomalyAuditEvent(
  req: Pick<Request, "headers" | "method" | "originalUrl" | "url"> & {
    sessionID: string;
  },
  previousIp: string,
  currentIp: string,
  mismatchCount: number,
): SessionAnomalyAuditEvent {
  const userAgentHeader = req.headers["user-agent"];
  const userAgent = Array.isArray(userAgentHeader)
    ? userAgentHeader[0]
    : userAgentHeader;

  return {
    event: "session.ip_mismatch",
    timestamp: new Date().toISOString(),
    sessionId: req.sessionID,
    method: req.method,
    path: loggedPath(req as Request),
    previousIp,
    currentIp,
    suspicious: true,
    mismatchCount,
    userAgent,
  };
}

export function logSessionAnomaly(
  event: SessionAnomalyAuditEvent,
  logger: Pick<Console, "warn"> = console,
): void {
  logger.warn(JSON.stringify(event));
}

export function sessionAnomalyLogger(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.session) {
    next();
    return;
  }

  const currentIp = getCurrentRequestIp(req);
  if (!currentIp) {
    next();
    return;
  }

  const previousIp = req.session.sessionIp;

  if (!previousIp) {
    req.session.sessionIp = currentIp;
    next();
    return;
  }

  if (previousIp !== currentIp) {
    const mismatchCount = (req.session.sessionIpMismatchCount ?? 0) + 1;
    req.session.sessionIpMismatchCount = mismatchCount;
    req.session.suspicious = true;
    req.session.suspiciousReason = "session_ip_mismatch";
    req.session.lastSessionAnomalyAt = new Date().toISOString();
    req.session.sessionIp = currentIp;

    logSessionAnomaly(
      buildSessionAnomalyAuditEvent(
        req as Request & { sessionID: string },
        previousIp,
        currentIp,
        mismatchCount,
      ),
    );
  }

  next();
}
