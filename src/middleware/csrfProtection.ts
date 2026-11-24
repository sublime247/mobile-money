/**
 * Double Submit Cookie CSRF protection for browser sessions (#2565).
 *
 * On login the server issues a random token in an HttpOnly, SameSite=Strict
 * cookie and returns the same token in the response body / `X-CSRF-Token`
 * response header. The dashboard keeps that value in memory and echoes it in
 * the `X-CSRF-Token` request header on every state-changing call. A
 * cross-site attacker can make the browser *send* the cookie but can neither
 * read it nor forge the matching header, so mismatched requests are rejected.
 *
 * Token format: `<nonce>.<issuedAtMs>.<hmac>` where
 *   - nonce     = 32 bytes from crypto.randomBytes (base64url),
 *   - issuedAt  = issue time, used to enforce a maximum token age,
 *   - hmac      = HMAC-SHA256(secret, nonce.issuedAt) so a client cannot
 *                 extend a token's lifetime by editing the timestamp.
 *
 * Header and cookie are compared with crypto.timingSafeEqual.
 *
 * Scope: CSRF only exists where the browser attaches credentials
 * automatically, i.e. cookies. Requests that carry no cookies at all (API
 * key / bearer-token integrations) are not forgeable cross-site and pass
 * through untouched. Any request that carries a Cookie header must present a
 * valid token for POST, PUT, PATCH and DELETE.
 */
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";
export const CSRF_PROTECTED_METHODS = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // one admin working day

export type CsrfFailureReason =
  | "CSRF_TOKEN_MISSING"
  | "CSRF_TOKEN_MISMATCH"
  | "CSRF_TOKEN_INVALID"
  | "CSRF_TOKEN_EXPIRED";

export type CsrfVerification =
  | { valid: true; reason?: undefined }
  | { valid: false; reason: CsrfFailureReason };

export interface CsrfOptions {
  /** HMAC key; defaults to CSRF_SECRET, then SESSION_SECRET / JWT_SECRET. */
  secret?: string;
  /** Maximum token age in ms (default 8h, env CSRF_TOKEN_TTL_MS). */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

function resolveSecret(options: CsrfOptions): string {
  const secret =
    options.secret ??
    process.env.CSRF_SECRET ??
    process.env.SESSION_SECRET ??
    process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CSRF_SECRET must be set in production");
    }
    return "dev-only-csrf-secret";
  }
  return secret;
}

function resolveTtl(options: CsrfOptions): number {
  if (options.ttlMs !== undefined) return options.ttlMs;
  const env = Number(process.env.CSRF_TOKEN_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TTL_MS;
}

function sign(secret: string, payload: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

/** Constant-time comparison that does not leak length via early return timing. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still burn a comparison of equal length so timing stays uniform.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function generateCsrfToken(options: CsrfOptions = {}): string {
  const now = options.now?.() ?? Date.now();
  const nonce = crypto.randomBytes(32).toString("base64url");
  const payload = `${nonce}.${now}`;
  return `${payload}.${sign(resolveSecret(options), payload)}`;
}

/** Validate structure, signature and age of a token. */
export function verifyCsrfToken(
  token: string,
  options: CsrfOptions = {},
): CsrfVerification {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "CSRF_TOKEN_INVALID" };
  const [nonce, issuedAtRaw, mac] = parts;
  const issuedAt = Number(issuedAtRaw);
  if (!nonce || !Number.isSafeInteger(issuedAt)) {
    return { valid: false, reason: "CSRF_TOKEN_INVALID" };
  }
  if (!safeEqual(mac, sign(resolveSecret(options), `${nonce}.${issuedAtRaw}`))) {
    return { valid: false, reason: "CSRF_TOKEN_INVALID" };
  }
  const now = options.now?.() ?? Date.now();
  if (now - issuedAt > resolveTtl(options) || issuedAt - now > 60_000) {
    return { valid: false, reason: "CSRF_TOKEN_EXPIRED" };
  }
  return { valid: true };
}

/** Minimal Cookie header parser (no cookie-parser dependency). */
export function readCookie(req: Request, name: string): string | undefined {
  const fromParser = (req as Request & { cookies?: Record<string, string> })
    .cookies?.[name];
  if (fromParser) return fromParser;
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Issue a fresh token: sets the HttpOnly SameSite cookie and the
 * `X-CSRF-Token` response header, and returns the token so callers can also
 * include it in a JSON body.
 */
export function issueCsrfToken(res: Response, options: CsrfOptions = {}): string {
  const token = generateCsrfToken(options);
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: resolveTtl(options),
  });
  res.setHeader("X-CSRF-Token", token);
  return token;
}

function reject(res: Response, reason: CsrfFailureReason, message: string) {
  return res.status(403).json({ error: "Forbidden", code: reason, message });
}

/**
 * Express middleware enforcing the Double Submit Cookie check on
 * state-changing methods for cookie-bearing (browser) requests.
 */
export function csrfProtection(options: CsrfOptions = {}) {
  // Fail fast at startup if production is missing a secret.
  resolveSecret(options);

  return function csrfMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (!CSRF_PROTECTED_METHODS.has(req.method.toUpperCase())) return next();

    // No ambient credentials -> nothing for an attacker to ride on.
    if (!req.headers.cookie) return next();

    const cookieToken = readCookie(req, CSRF_COOKIE_NAME);
    const headerValue = req.headers[CSRF_HEADER_NAME];
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!cookieToken || !headerToken) {
      return reject(
        res,
        "CSRF_TOKEN_MISSING",
        "CSRF token missing: send the X-CSRF-Token header issued at login",
      );
    }
    if (!safeEqual(headerToken, cookieToken)) {
      return reject(res, "CSRF_TOKEN_MISMATCH", "CSRF token mismatch");
    }
    const verdict = verifyCsrfToken(cookieToken, options);
    if (verdict.reason) {
      return reject(
        res,
        verdict.reason,
        verdict.reason === "CSRF_TOKEN_EXPIRED"
          ? "CSRF token expired; refresh it via GET /api/admin/csrf-token"
          : "CSRF token invalid",
      );
    }
    return next();
  };
}
