import jwt from "jsonwebtoken";
import {
  getActiveSigningKey,
  getVerificationKeys,
} from "../auth/jwtKeys";

/**
 * Core JWT signing/verification utilities (issue #1971).
 *
 * Zero-downtime secret rotation support:
 * - Tokens are always signed with the current primary secret.
 * - Verification tries the primary secret first, then any secondary
 *   secrets still inside the grace window (`JWT_KEY_GRACE_PERIOD_HOURS`,
 *   default 24h). Expired secondary secrets are deprecated automatically.
 */

export const JWT_EXPIRES_IN = "1h";

export interface JWTImpersonationClaim {
  active: true;
  readOnly: true;
  actorUserId: string;
  actorRole: string;
  targetUserId: string;
  reason: string;
  issuedAt: string;
}

export interface JWTPayload {
  userId: string;
  email: string;
  role?: string;
  impersonation?: JWTImpersonationClaim;
  tokenVersion?: number;
  iat?: number;
  exp?: number;
}

interface GenerateTokenOptions {
  expiresIn?: string | number;
}

/**
 * Signs a new token with the current primary secret.
 * The `kid` header identifies which key version signed the token so
 * verifiers can prefer the matching key first.
 */
export function generateToken(
  payload: Omit<JWTPayload, "iat" | "exp">,
  options?: GenerateTokenOptions,
): string {
  const { key, kid } = getActiveSigningKey();
  const expiresIn = options?.expiresIn ?? JWT_EXPIRES_IN;
  return jwt.sign(payload, key, {
    expiresIn: typeof expiresIn === "string" ? expiresIn : expiresIn,
    header: { alg: "HS256", kid },
  } as jwt.SignOptions);
}

/**
 * Verifies an incoming token against both the primary secret and any
 * secondary secrets still within their rotation grace window.
 *
 * @param token - JWT token to verify
 * @returns Decoded token payload
 * @throws Error if the token is invalid or expired under every configured key
 */
export function verifyToken(token: string): JWTPayload {
  const keys = getVerificationKeys();
  let lastError: unknown;
  for (const { key, kid } of keys) {
    try {
      const decoded = jwt.verify(token, key, {
        clockTolerance: 60,
      }) as JWTPayload;
      return decoded;
    } catch (error: unknown) {
      lastError = error;
      if (error instanceof jwt.TokenExpiredError) {
        // An expired token stays expired under every key — fail fast.
        throw new Error("Token has expired", { cause: error });
      }
      // Signature mismatch for this key version; try the next one.
      if (process.env.NODE_ENV !== "test") {
        jwtDebug(`verification failed for kid=${kid}`, error);
      }
    }
  }
  if (lastError instanceof jwt.TokenExpiredError) {
    throw new Error("Token has expired", { cause: lastError });
  }
  if (lastError instanceof jwt.JsonWebTokenError) {
    throw new Error("Invalid token", { cause: lastError });
  }
  throw new Error("Token verification failed", { cause: lastError });
}

/**
 * Checks if a token is expired without throwing an error.
 * @param token - JWT token to check
 * @returns True if the token is expired, false otherwise
 */
export function isTokenExpired(token: string): boolean {
  try {
    verifyToken(token);
    return false;
  } catch (error) {
    return error instanceof Error && error.message === "Token has expired";
  }
}

function jwtDebug(message: string, error: unknown): void {
  // Kept minimal — avoids leaking token material; aids rotation debugging.
  const detail = error instanceof Error ? error.message : "unknown error";
  console.debug(`[jwt] ${message}: ${detail}`);
}
