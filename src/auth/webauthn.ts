export {
  generateWebAuthnChallenge,
  verifyWebAuthnAssertion,
  enforceAdminHardwareBinding,
  WEBAUTHN_CHALLENGE_TTL_SECONDS,
} from "../services/auth/webauthn";

export function getRpConfig(): {
  rpName: string;
  rpID: string;
  origin: string;
} {
  return {
    rpName: process.env.WEBAUTHN_RP_NAME || "Mobile Money Admin",
    rpID: process.env.WEBAUTHN_RP_ID || "localhost",
    origin: process.env.WEBAUTHN_ORIGIN || "http://localhost:3000",
  };
}

export function generateRegistrationOptionsForUser(userId: string) {
  const { generateWebAuthnChallenge } = require("../services/auth/webauthn");
  return generateWebAuthnChallenge(userId);
}

export function generateAuthenticationOptionsForUser(userId: string) {
  const { generateWebAuthnChallenge } = require("../services/auth/webauthn");
  return generateWebAuthnChallenge(userId);
}

export async function verifyRegistration(response: any) {
  const { verifyWebAuthnAssertion } = require("../services/auth/webauthn");
  return verifyWebAuthnAssertion(response);
}

export async function verifyAuthentication(response: any) {
  const { verifyWebAuthnAssertion } = require("../services/auth/webauthn");
  return verifyWebAuthnAssertion(response);
}
