import { NextFunction, Request, Response } from "express";
import type { Session, SessionData } from "express-session";
import {
  buildSessionAnomalyAuditEvent,
  getCurrentRequestIp,
  normalizeIpAddress,
  sessionAnomalyLogger,
} from "../../src/services/logger";

type MockRequest = Partial<Request> & {
  session: Session & Partial<SessionData>;
  sessionID: string;
};

function createRequest(overrides: Partial<MockRequest> = {}): Request {
  return {
    method: "GET",
    originalUrl: "/api/transactions",
    url: "/api/transactions",
    ip: "1.1.1.1",
    headers: {},
    sessionID: "session-123",
    session: {},
    ...overrides,
  } as Request;
}

describe("session anomaly logger", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("stores the first observed session IP", () => {
    const req = createRequest();
    const next = jest.fn() as NextFunction;

    sessionAnomalyLogger(req, {} as Response, next);

    expect(req.session.sessionIp).toBe("1.1.1.1");
    expect(req.session.suspicious).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it("logs and flags the session when the IP changes", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const req = createRequest({
      ip: "2.2.2.2",
      session: {
        sessionIp: "1.1.1.1",
      },
    });
    const next = jest.fn() as NextFunction;

    sessionAnomalyLogger(req, {} as Response, next);

    expect(req.session.sessionIp).toBe("2.2.2.2");
    expect(req.session.suspicious).toBe(true);
    expect(req.session.suspiciousReason).toBe("session_ip_mismatch");
    expect(req.session.sessionIpMismatchCount).toBe(1);
    expect(next).toHaveBeenCalled();

    const payload = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(payload.event).toBe("session.ip_mismatch");
    expect(payload.previousIp).toBe("1.1.1.1");
    expect(payload.currentIp).toBe("2.2.2.2");
  });

  it("uses the forwarded client IP when present", () => {
    const req = createRequest({
      ip: "10.0.0.2",
      headers: {
        "x-forwarded-for": "203.0.113.10, 10.0.0.2",
      },
    });

    expect(getCurrentRequestIp(req)).toBe("203.0.113.10");
  });

  it("normalizes IPv6-mapped IPv4 addresses", () => {
    expect(normalizeIpAddress("::ffff:198.51.100.2")).toBe("198.51.100.2");
  });

  it("builds a structured audit event", () => {
    const event = buildSessionAnomalyAuditEvent(
      createRequest({
        headers: {
          "user-agent": "jest",
        },
      }) as Request & { sessionID: string },
      "1.1.1.1",
      "2.2.2.2",
      2,
    );

    expect(event.sessionId).toBe("session-123");
    expect(event.path).toBe("/api/transactions");
    expect(event.mismatchCount).toBe(2);
    expect(event.userAgent).toBe("jest");
  });
});
