/**
 * WebAuthn Controller — HTTP handlers for hardware-key (YubiKey) 2FA.
 *
 * Endpoints
 * ─────────
 *  Registration (one-time key setup, requires valid JWT)
 *    GET    /api/auth/webauthn/register/challenge
 *    POST   /api/auth/webauthn/register
 *    GET    /api/auth/webauthn/credentials
 *    DELETE /api/auth/webauthn/credentials/:credentialId
 *
 *  Authentication (called during / after admin login)
 *    GET  /api/auth/webauthn/authenticate/challenge
 *    POST /api/auth/webauthn/authenticate
 *
 * Acceptance criteria enforced
 * ────────────────────────────
 * ✔ Generate WebAuthn challenge parameters (registration + authentication)
 * ✔ Verify assertions signed by hardware keys
 * ✔ Block login attempts missing token codes (POST /authenticate returns 401
 *   on any verification failure)
 */

import type { Request, Response } from "express";
import { z } from "zod";
import type { JWTPayload } from "../auth/jwt";
import {
  generateRegistrationChallenge,
  verifyAndSaveCredential,
  generateAuthenticationChallenge,
  verifyAuthenticationAssertion,
  getCredentialsByUserId,
  removeCredential,
} from "../services/auth/webauthn";
import { getUserById } from "../services/userService";

// ─── Input schemas ────────────────────────────────────────────────────────────

/** Optional device name sent alongside the registration response. */
const registerCompleteSchema = z.object({
  response: z.unknown(), // passed directly to @simplewebauthn/server
  deviceName: z.string().max(64).optional(),
});

const authenticateCompleteSchema = z.object({
  userId: z.string().uuid("userId must be a valid UUID"),
  response: z.unknown(), // assertion from the authenticator
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the authenticated user ID from the JWT attached by authenticateToken middleware. */
function requireUserId(req: Request, res: Response): string | null {
  const jwt = req.jwtUser as JWTPayload | undefined;
  if (!jwt?.userId) {
    res.status(401).json({ error: "Unauthorized", message: "Valid JWT required" });
    return null;
  }
  return jwt.userId;
}

// ─── Controller ───────────────────────────────────────────────────────────────

export const authController = {
  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * GET /api/auth/webauthn/register/challenge
   *
   * Returns PublicKeyCredentialCreationOptions that the browser passes to
   * navigator.credentials.create(). Requires a valid JWT (user must be
   * already authenticated to register a new key).
   */
  async getRegistrationChallenge(req: Request, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;

    try {
      const user = await getUserById(userId);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const { options } = await generateRegistrationChallenge(
        userId,
        user.phone_number,
      );

      res.json({ options });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res
        .status(500)
        .json({ error: "Failed to generate registration challenge", message });
    }
  },

  /**
   * POST /api/auth/webauthn/register
   *
   * Accepts the raw RegistrationResponseJSON from the browser and verifies it.
   * On success the credential is persisted and the key is ready for login.
   */
  async completeRegistration(req: Request, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const parsed = registerCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const { response, deviceName } = parsed.data;

    try {
      const { credential } = await verifyAndSaveCredential(
        userId,
        response as any, // RegistrationResponseJSON typed inside service
        deviceName,
      );

      res.status(201).json({
        message: "Hardware key registered successfully",
        credentialId: credential.credential_id,
        deviceName: credential.device_name,
        createdAt: credential.created_at,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const isClientError =
        message.includes("challenge expired") ||
        message.includes("verification failed");
      res.status(isClientError ? 400 : 500).json({
        error: "Hardware key registration failed",
        message,
      });
    }
  },

  /**
   * GET /api/auth/webauthn/credentials
   *
   * List all registered hardware keys for the authenticated user.
   */
  async listCredentials(req: Request, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;

    try {
      const credentials = await getCredentialsByUserId(userId);
      res.json({
        credentials: credentials.map((c) => ({
          credentialId: c.credential_id,
          deviceName: c.device_name,
          createdAt: c.created_at,
          lastUsedAt: c.last_used_at,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: "Failed to list credentials", message });
    }
  },

  /**
   * DELETE /api/auth/webauthn/credentials/:credentialId
   *
   * De-register a specific hardware key. Only the key's owner can remove it.
   */
  async deleteCredential(req: Request, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const { credentialId } = req.params;
    if (!credentialId) {
      res.status(400).json({ error: "credentialId is required" });
      return;
    }

    try {
      const removed = await removeCredential(credentialId, userId);
      if (!removed) {
        res.status(404).json({
          error: "Credential not found or does not belong to this account",
        });
        return;
      }
      res.json({ message: "Hardware key removed successfully" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: "Failed to remove credential", message });
    }
  },

  // ── Authentication ────────────────────────────────────────────────────────

  /**
   * GET /api/auth/webauthn/authenticate/challenge?userId=<uuid>
   *
   * Returns PublicKeyCredentialRequestOptions for navigator.credentials.get().
   * Unauthenticated endpoint — user has password credentials but does not yet
   * hold a JWT.
   */
  async getAuthenticationChallenge(req: Request, res: Response): Promise<void> {
    const userId = req.query["userId"] as string | undefined;
    if (!userId) {
      res
        .status(400)
        .json({ error: "userId query parameter is required" });
      return;
    }

    try {
      const { options } = await generateAuthenticationChallenge(userId);
      res.json({ options });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const isClientError = message.includes("No hardware keys registered");
      res.status(isClientError ? 400 : 500).json({
        error: "Failed to generate authentication challenge",
        message,
      });
    }
  },

  /**
   * POST /api/auth/webauthn/authenticate
   *
   * Verifies the assertion signed by the hardware key.
   *
   * On success: `{ verified: true }` — the caller may proceed to issue a JWT.
   * On failure: HTTP 401 — the login is BLOCKED.
   *
   * This enforces the acceptance criterion:
   * "Block login attempts missing token codes."
   */
  async verifyAuthentication(req: Request, res: Response): Promise<void> {
    const parsed = authenticateCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const { userId, response } = parsed.data;

    try {
      const result = await verifyAuthenticationAssertion(
        userId,
        response as any,
      );

      res.json({
        verified: result.verified,
        message: "Hardware key authentication successful",
      });
    } catch (err) {
      // Any error here means the assertion could not be verified.
      // We BLOCK the login by returning 401.
      const message =
        err instanceof Error
          ? err.message
          : "Hardware key authentication failed";
      res.status(401).json({
        verified: false,
        error: "Hardware key authentication failed",
        message,
      });
    }
  },
};
