import argon2 from "argon2";
import bcrypt from "bcrypt";
import { createHmac } from "crypto";
import logger from "../utils/logger";

/**
 * Admin password hashing: Argon2id with an optional server-side pepper.
 *
 * - New hashes are Argon2id (OWASP minimum parameters: 19 MiB memory,
 *   2 iterations, 1 lane).
 * - When `ADMIN_PASSWORD_PEPPER` is set, the password is keyed with
 *   HMAC-SHA256 under that secret before hashing, so a leaked database alone
 *   is not enough to run offline guesses. Rotating the pepper invalidates
 *   existing hashes, so change it only with a password reset plan.
 * - Legacy bcrypt hashes (`$2a$`, `$2b$`, `$2y$`) still verify, and the
 *   verification result tells the caller to store a fresh Argon2id hash.
 */

export const ADMIN_ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

const BCRYPT_PREFIX = /^\$2[aby]\$/;
const ARGON2ID_PREFIX = "$argon2id$";

let pepperWarningLogged = false;

/** Read the pepper from the environment. Empty string means "not set". */
export function getAdminPasswordPepper(): string {
  return process.env.ADMIN_PASSWORD_PEPPER ?? "";
}

/**
 * Combine the password with the pepper. Without a pepper the password is used
 * as-is, and a single warning is logged so the gap is visible in production.
 */
export function applyPepper(password: string, pepper = getAdminPasswordPepper()): string {
  if (!pepper) {
    if (!pepperWarningLogged) {
      pepperWarningLogged = true;
      logger.warn("ADMIN_PASSWORD_PEPPER is not set; admin passwords are hashed without a pepper");
    }
    return password;
  }
  return createHmac("sha256", pepper).update(password, "utf8").digest("base64");
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string");
  }
}

/** Hash an admin password with Argon2id (and the pepper when configured). */
export async function hashAdminPassword(password: string): Promise<string> {
  assertPassword(password);
  return argon2.hash(applyPepper(password), ADMIN_ARGON2_OPTIONS);
}

export function isLegacyBcryptHash(stored: string): boolean {
  return BCRYPT_PREFIX.test(stored);
}

export interface AdminPasswordVerification {
  /** True when the password matches the stored hash. */
  valid: boolean;
  /**
   * Replacement Argon2id hash to persist after a successful login. Set only
   * when the stored hash is legacy bcrypt or its Argon2id parameters are
   * older than the current policy.
   */
  newHash?: string;
}

/**
 * Verify an admin password against a stored hash. On success for a legacy
 * bcrypt hash, or an Argon2id hash with outdated parameters, returns a fresh
 * Argon2id hash for the caller to store (the upgrade migration).
 *
 * Malformed or unknown hash formats fail closed (`valid: false`).
 */
export async function verifyAdminPassword(
  password: string,
  stored: string,
): Promise<AdminPasswordVerification> {
  if (typeof password !== "string" || typeof stored !== "string" || !stored) {
    return { valid: false };
  }

  if (isLegacyBcryptHash(stored)) {
    // Legacy hashes were created from the raw password, before the pepper.
    const valid = await bcrypt.compare(password, stored);
    if (!valid) return { valid: false };
    return { valid: true, newHash: await hashAdminPassword(password) };
  }

  if (stored.startsWith(ARGON2ID_PREFIX)) {
    let valid = false;
    try {
      valid = await argon2.verify(stored, applyPepper(password));
    } catch {
      // Corrupt Argon2 encodings are treated as a failed login, not a 500.
      return { valid: false };
    }
    if (!valid) return { valid: false };
    const outdated = await argon2.needsRehash(stored, ADMIN_ARGON2_OPTIONS);
    return outdated
      ? { valid: true, newHash: await hashAdminPassword(password) }
      : { valid: true };
  }

  return { valid: false };
}
