import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  Base64URLString,
} from "@simplewebauthn/server";
import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import { encrypt, decrypt } from "../utils/encryption";

// ─── Configuration ────────────────────────────────────────────────────────────

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes

export function getRpConfig(): { rpName: string; rpID: string; origin: string } {
  return {
    rpName: process.env.WEBAUTHN_RP_NAME || "Mobile Money App",
    rpID: process.env.WEBAUTHN_RP_ID || "localhost",
    origin: process.env.WEBAUTHN_ORIGIN || "http://localhost:3000",
  };
}