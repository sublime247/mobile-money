
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { RefreshTokenFamilyModel } from "../models/refreshTokenFamily";

dotenv.config();

const JWT_EXPIRES_IN = "1h";
const REFRESH_TOKEN_EXPIRES_IN = "7d";
const refreshTokenFamilyModel = new RefreshTokenFamilyModel();

export interface JWTImpersonationClaim {
  active: true;
  readOnly: true;
  actorUserId: string;
  actorRole: string;
  targetUserId: string;
  reason: string;
  issuedAt: string;
}

interface GenerateTokenOptions {
  expiresIn?: string | number;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not defined in environment variables");
  }
  return secret;
}

export interface JWTPayload {
  userId: string;
  email: string;
  role?: string;
  impersonation?: JWTImpersonationClaim;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  userId: string;
  familyId: string;
  tokenId: string;
  parentTokenId?: string;
  iat?: number;
  exp?: number;
}


/**
 * Generates a JWT token for the given user payload
 * @param payload - User data to include in the token
 * @returns Signed JWT token
 */
export function generateToken(
  payload: Omit<JWTPayload, "iat" | "exp">,
  options?: GenerateTokenOptions,
): string {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: options?.expiresIn ?? JWT_EXPIRES_IN,
  });
}

/**
 * Generates a refresh token and tracks its family chain
 * @param userId - User's ID
 * @param familyId - Family chain ID (new for first token)
 * @param parentTokenId - Parent token ID (if rotating)
 * @returns Signed refresh token
 */
export async function generateRefreshToken(userId: string, familyId?: string, parentTokenId?: string): Promise<string> {
  const tokenId = uuidv4();
  const famId = familyId || uuidv4();
  const payload: RefreshTokenPayload = {
    userId,
    familyId: famId,
    tokenId,
    parentTokenId,
  };
  const token = jwt.sign(payload, getJwtSecret(), {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
  });
  await refreshTokenFamilyModel.create({ user_id: userId, family_id: famId, token, parent_token: parentTokenId });
  return token;
}


/**
 * Verifies a JWT token and returns the decoded payload
 * @param token - JWT token to verify
 * @returns Decoded token payload
 * @throws Error if token is invalid or expired
 */
export function verifyToken(token: string): JWTPayload {
  const secret = getJwtSecret();
  try {
    const decoded = jwt.verify(token, secret) as JWTPayload;
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Token has expired");
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid token");
    } else {
      throw new Error("Token verification failed");
    }
  }
}

/**
 * Verifies a refresh token, detects reuse, and revokes family if reused
 * @param token - Refresh token to verify
 * @returns Decoded refresh token payload
 * @throws Error if token is invalid, expired, or reused
 */
export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const secret = getJwtSecret();
  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(token, secret) as RefreshTokenPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Refresh token has expired");
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid refresh token");
    } else {
      throw new Error("Refresh token verification failed");
    }
  }
  // Check for reuse
  const dbToken = await refreshTokenFamilyModel.findByToken(token);
  if (!dbToken || dbToken.is_revoked) {
    // Revoke the whole family if reused
    if (decoded.familyId) {
      await refreshTokenFamilyModel.revokeFamily(decoded.familyId);
    }
    throw new Error("Refresh token reuse detected. All tokens in this chain are revoked. Please re-login.");
  }
  return decoded;
}

/**
 * Checks if a token is expired without throwing an error
 * @param token - JWT token to check
 * @returns True if token is expired, false otherwise
 */
export function isTokenExpired(token: string): boolean {
  try {
    verifyToken(token);
    return false;
  } catch (error) {
    return error instanceof Error && error.message === "Token has expired";
  }
}
