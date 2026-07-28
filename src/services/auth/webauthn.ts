/**
 * WebAuthn Service — YubiKey / hardware-key support for admin logins.
 *
 * Implements the full registration and authentication lifecycle using the
 * @simplewebauthn/server library (FIDO2 / WebAuthn Level-2 compliant).
 *
 * Flow
 * ────
 * Registration (one-time key setup)
 *   1. GET  /api/auth/webauthn/register/challenge  → generateRegistrationChallenge()
 *   2. POST /api/auth/webauthn/register            → verifyAndSaveCredential()
 *
 * Authentication (each admin login)
 *   1. GET  /api/auth/webauthn/authenticate/challenge → generateAuthenticationChallenge()
 *   2. POST /api/auth/webauthn/authenticate           → verifyAuthenticationResponse()
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/types";
import { queryRead, queryWrite } from "../../config/database";
import { redisClient } from "../../config/redis";

// ─── Configuration ────────────────────────────────────────────────────────────

/** Seconds a challenge remains valid before it is rejected. */
export const CHALLENGE_TTL_SECONDS = 300; // 5 minutes

function getRpConfig(): { rpName: string; rpID: string; origin: string } {
  return {
    rpName: process.env.WEBAUTHN_RP_NAME ?? "Mobile Money Admin",
    rpID: process.env.WEBAUTHN_RP_ID ?? "localhost",
    origin: process.env.WEBAUTHN_ORIGIN ?? "http://localhost:3000",
  };
}

// ─── Redis key helpers ────────────────────────────────────────────────────────

const registrationChallengeKey = (userId: string) =>
  `webauthn:reg_challenge:${userId}`;

const authChallengeKey = (userId: string) =>
  `webauthn:auth_challenge:${userId}`;

// ─── DB helpers ───────────────────────────────────────────────────────────────

export interface StoredCredential {
  id: string;
  user_id: string;
  credential_id: string; // base64url-encoded
  public_key: Buffer;
  sign_count: number;
  transports: string[] | null;
  device_name: string | null;
  created_at: Date;
  last_used_at: Date | null;
}

/**
 * Persist a newly verified credential after successful registration.
 */
async function saveCredential(
  userId: string,
  credentialId: string,
  publicKey: Uint8Array,
  signCount: number,
  transports: string[] | undefined | null,
  deviceName: string | null,
): Promise<StoredCredential> {
  const result = await queryWrite(
    `INSERT INTO webauthn_credentials
       (user_id, credential_id, public_key, sign_count, transports, device_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      userId,
      credentialId,
      Buffer.from(publicKey),
      signCount,
      transports ?? null,
      deviceName,
    ],
  );
  return result.rows[0] as StoredCredential;
}

/**
 * Load all credentials registered for a user.
 */
export async function getCredentialsByUserId(
  userId: string,
): Promise<StoredCredential[]> {
  const result = await queryRead(
    `SELECT * FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows as StoredCredential[];
}

/**
 * Load a single credential by its base64url credential ID.
 */
async function getCredentialById(
  credentialId: string,
): Promise<StoredCredential | null> {
  const result = await queryRead(
    `SELECT * FROM webauthn_credentials WHERE credential_id = $1`,
    [credentialId],
  );
  return result.rows[0] ?? null;
}

/**
 * Update the sign counter and last-used timestamp after a successful assertion.
 */
async function updateSignCount(
  credentialId: string,
  newSignCount: number,
): Promise<void> {
  await queryWrite(
    `UPDATE webauthn_credentials
        SET sign_count = $1, last_used_at = NOW()
      WHERE credential_id = $2`,
    [newSignCount, credentialId],
  );
}

/**
 * Remove a credential (for key de-registration).
 */
export async function removeCredential(
  credentialId: string,
  userId: string,
): Promise<boolean> {
  const result = await queryWrite(
    `DELETE FROM webauthn_credentials WHERE credential_id = $1 AND user_id = $2`,
    [credentialId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── Registration ─────────────────────────────────────────────────────────────

export interface RegistrationChallengeResult {
  options: PublicKeyCredentialCreationOptionsJSON;
}

/**
 * Generate WebAuthn registration options and persist the challenge in Redis.
 *
 * @param userId    Internal user ID (UUID)
 * @param userEmail Human-readable display name shown on the key
 */
export async function generateRegistrationChallenge(
  userId: string,
  userEmail: string,
): Promise<RegistrationChallengeResult> {
  const { rpName, rpID } = getRpConfig();

  // Exclude credentials the user already has registered so the key is not
  // registered twice.
  const existing = await getCredentialsByUserId(userId);
  const excludeCredentials = existing.map((c) => ({
    id: c.credential_id,
    type: "public-key" as const,
    transports: (c.transports ?? []) as AuthenticatorTransport[],
  }));

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(userId),
    userName: userEmail,
    userDisplayName: userEmail,
    attestationType: "none", // No attestation required — works with all keys
    excludeCredentials,
    authenticatorSelection: {
      // Require a roaming authenticator (YubiKey, security key)
      authenticatorAttachment: "cross-platform",
      residentKey: "preferred",
      userVerification: "preferred",
    },
    // Support ES256 and RS256 — most YubiKeys ship with one of these
    supportedAlgorithmIDs: [-7, -257],
  });

  // Store the challenge in Redis so we can verify it in the next step.
  await redisClient.setEx(
    registrationChallengeKey(userId),
    CHALLENGE_TTL_SECONDS,
    options.challenge,
  );

  return { options };
}

export interface VerifyRegistrationResult {
  credential: StoredCredential;
  verified: boolean;
}

/**
 * Verify the authenticator's registration response and persist the credential.
 *
 * @param userId     Owner of the credential
 * @param response   Raw JSON body from the browser's navigator.credentials.create()
 * @param deviceName Optional human-readable label (e.g. "YubiKey 5 NFC")
 */
export async function verifyAndSaveCredential(
  userId: string,
  response: RegistrationResponseJSON,
  deviceName?: string,
): Promise<VerifyRegistrationResult> {
  const { rpID, origin } = getRpConfig();

  // Retrieve and immediately delete the one-time challenge.
  const challengeKey = registrationChallengeKey(userId);
  const expectedChallenge = await redisClient.get(challengeKey);
  if (!expectedChallenge) {
    throw new Error("Registration challenge expired or not found");
  }
  await redisClient.del(challengeKey);

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: String(expectedChallenge),
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("WebAuthn registration verification failed");
  }

  const { credential } = verification.registrationInfo;

  const stored = await saveCredential(
    userId,
    credential.id,
    credential.publicKey,
    credential.counter,
    credential.transports as string[] | undefined,
    deviceName ?? null,
  );

  return { credential: stored, verified: true };
}

// ─── Authentication ───────────────────────────────────────────────────────────

export interface AuthenticationChallengeResult {
  options: PublicKeyCredentialRequestOptionsJSON;
}

/**
 * Generate a WebAuthn authentication challenge for a user that already has at
 * least one registered hardware key.
 *
 * Throws if the user has no registered credentials.
 */
export async function generateAuthenticationChallenge(
  userId: string,
): Promise<AuthenticationChallengeResult> {
  const { rpID } = getRpConfig();

  const credentials = await getCredentialsByUserId(userId);
  if (credentials.length === 0) {
    throw new Error(
      "No hardware keys registered for this user. Complete registration first.",
    );
  }

  const allowCredentials = credentials.map((c) => ({
    id: c.credential_id,
    type: "public-key" as const,
    transports: (c.transports ?? []) as AuthenticatorTransport[],
  }));

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: "preferred",
  });

  // Persist challenge for verification.
  await redisClient.setEx(
    authChallengeKey(userId),
    CHALLENGE_TTL_SECONDS,
    options.challenge,
  );

  return { options };
}

export interface AuthenticationVerificationResult {
  verified: boolean;
  credentialId: string;
  newSignCount: number;
}

/**
 * Verify the assertion produced by the hardware key during login.
 *
 * Returns `{ verified: true }` on success.
 * Throws on failure — callers MUST treat any thrown error as an authentication
 * failure and block the login accordingly.
 */
export async function verifyAuthenticationAssertion(
  userId: string,
  response: AuthenticationResponseJSON,
): Promise<AuthenticationVerificationResult> {
  const { rpID, origin } = getRpConfig();

  // Retrieve and immediately delete the one-time challenge.
  const challengeKey = authChallengeKey(userId);
  const expectedChallenge = await redisClient.get(challengeKey);
  if (!expectedChallenge) {
    throw new Error("Authentication challenge expired or not found");
  }
  await redisClient.del(challengeKey);

  // Look up the specific credential being used.
  const storedCredential = await getCredentialById(response.id);
  if (!storedCredential || storedCredential.user_id !== userId) {
    throw new Error("Credential not found or does not belong to this user");
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: String(expectedChallenge),
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: storedCredential.credential_id,
      publicKey: new Uint8Array(storedCredential.public_key),
      counter: storedCredential.sign_count,
      transports: (storedCredential.transports ?? []) as AuthenticatorTransport[],
    },
    requireUserVerification: false,
  });

  if (!verification.verified) {
    throw new Error("WebAuthn authentication verification failed");
  }

  const { newCounter } = verification.authenticationInfo;

  // Persist the new counter to prevent replay attacks.
  await updateSignCount(storedCredential.credential_id, newCounter);

  return {
    verified: true,
    credentialId: storedCredential.credential_id,
    newSignCount: newCounter,
  };
}

// ─── Guard helper (used in login route) ──────────────────────────────────────

/**
 * Returns true when the user has at least one WebAuthn credential registered.
 * Used by the login route to enforce the "block login attempts missing token
 * codes" acceptance criterion.
 */
export async function hasWebAuthnCredentials(userId: string): Promise<boolean> {
  const result = await queryRead(
    `SELECT 1 FROM webauthn_credentials WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return result.rowCount! > 0;
}
