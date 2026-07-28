/**
 * Re-export shim — the real implementation lives in
 * src/services/auth/webauthn.ts.
 *
 * This file is kept so that any existing import paths pointing to
 * `../auth/webauthn` continue to resolve without modification.
 */
export {
  CHALLENGE_TTL_SECONDS,
  generateRegistrationChallenge,
  verifyAndSaveCredential,
  generateAuthenticationChallenge,
  verifyAuthenticationAssertion,
  getCredentialsByUserId,
  removeCredential,
  hasWebAuthnCredentials,
} from "../services/auth/webauthn";
