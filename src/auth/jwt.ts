import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { RefreshTokenFamilyModel } from "../models/refreshTokenFamily";
import {
  getActiveSigningKey,
  getVerificationKeys,
} from "./jwtKeys";
import {
  generateToken as coreGenerateToken,
  verifyToken as coreVerifyToken,
  isTokenExpired as coreIsTokenExpired,
  JWT_EXPIRES_IN,
  JWTImpersonationClaim,
  JWTPayload,
} from "../utils/jwt";

dotenv.config();

const REFRESH_TOKEN_EXPIRES_IN = "7d";
const refreshTokenFamilyModel = new RefreshTokenFamilyModel();

export { JWT_EXPIRES_IN, coreVerifyToken as verifyToken };
export type { JWTImpersonationClaim, JWTPayload };

/**
 * Generates a JWT token for the given user payload
 * @param payload - User data to include in the token
 * @returns Signed JWT token
 */
export function generateToken(
  payload: Omit<JWTPayload, "iat" | "exp">,
  options?: { expiresIn?: string | number },
): string {
  return coreGenerateToken(payload, options);
}

/**
 * Generates a refresh token and tracks its family chain
 * @param userId - User's ID
 * @param familyId - Family chain ID (new for first token)
 * @param parentTokenId - Parent token ID (if rotating)
 * @returns Signed refresh token
 */
export async function generateRefreshToken(
  userId: string,
  familyId?: string,
  parentTokenId?: string,
): Promise<string> {
  const tokenId = uuidv4();
  const famId = familyId || uuidv4();
  const payload: RefreshTokenPayload = {
    userId,
    familyId: famId,
    tokenId,
    parentTokenId,
  };
  const { key, kid } = getActiveSigningKey();
  const token = jwt.sign(payload, key, {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
    header: { alg: "HS256", kid },
  } as jwt.SignOptions);
  await refreshTokenFamilyModel.create({
    user_id: userId,
    family_id: famId,
    token,
    parent_token: parentTokenId,
  });
  return token;
}

/**
 * Verifies a refresh token, detects reuse, and revokes family if reused
 * @param token - Refresh token to verify
 * @returns Decoded refresh token payload
 * @throws Error if token is invalid, expired, or reused
 */
export async function verifyRefreshToken(
  token: string,
): Promise<RefreshTokenPayload> {
  const keys = getVerificationKeys();
  let decoded: RefreshTokenPayload | null = null;
  let lastError: unknown;
  for (const { key } of keys) {
    try {
      decoded = jwt.verify(token, key) as RefreshTokenPayload;
      break;
    } catch (error: unknown) {
      lastError = error;
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error("Refresh token has expired", { cause: error });
      }
    }
  }
  if (!decoded) {
    if (lastError instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid refresh token", { cause: lastError });
    }
    throw new Error("Refresh token verification failed", { cause: lastError });
  }
  // Check for reuse
  const dbToken = await refreshTokenFamilyModel.findByToken(token);
  if (!dbToken || dbToken.is_revoked) {
    // Revoke the whole family if reused
    if (decoded.familyId && decoded.userId) {
      await refreshTokenFamilyModel.revokeFamily(
        decoded.familyId,
        decoded.userId,
        "reuse_detected",
      );
    }
    throw new Error(
      "Refresh token reuse detected. All tokens in this chain are revoked. Please re-login.",
    );
  }
  return decoded;
}

/**
 * Checks if a token is expired without throwing an error
 * @param token - JWT token to check
 * @returns True if token is expired, false otherwise
 */
export function isTokenExpired(token: string): boolean {
  return coreIsTokenExpired(token);
}

export interface RefreshTokenPayload {
  userId: string;
  familyId: string;
  tokenId: string;
  parentTokenId?: string;
  iat?: number;
  exp?: number;
}

// Kept for internal re-use by callers importing from auth/jwt only.
export { coreVerifyToken };
