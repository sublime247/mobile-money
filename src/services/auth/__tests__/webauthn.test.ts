import {
  generateWebAuthnChallenge,
  verifyWebAuthnAssertion,
  enforceAdminHardwareBinding,
} from "../webauthn";

describe("WebAuthn Hardware Binding Security (#1650)", () => {
  const userId = "admin-user-123";

  it("generates WebAuthn challenge parameters", () => {
    const opts = generateWebAuthnChallenge(userId, "admin@example.com");
    expect(opts.challenge).toBeDefined();
    expect(opts.rp.name).toBeDefined();
    expect(opts.user.name).toBe("admin@example.com");
    expect(opts.pubKeyCredParams.length).toBeGreaterThan(0);
  });

  it("verifies assertions signed by hardware keys", () => {
    const opts = generateWebAuthnChallenge(userId);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ challenge: opts.challenge, origin: "http://localhost:3000" }),
    ).toString("base64url");

    const assertion = {
      credentialId: "cred_123",
      clientDataJSON,
      authenticatorData: Buffer.from("auth_data").toString("base64url"),
      signature: Buffer.from("sig_data").toString("base64url"),
      challenge: opts.challenge,
    };

    const res = verifyWebAuthnAssertion(assertion);
    expect(res.verified).toBe(true);
  });

  it("rejects assertions with mismatched challenge", () => {
    const opts = generateWebAuthnChallenge(userId);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ challenge: "wrong_challenge", origin: "http://localhost:3000" }),
    ).toString("base64url");

    const assertion = {
      credentialId: "cred_123",
      clientDataJSON,
      authenticatorData: Buffer.from("auth_data").toString("base64url"),
      signature: Buffer.from("sig_data").toString("base64url"),
      challenge: opts.challenge,
    };

    const res = verifyWebAuthnAssertion(assertion);
    expect(res.verified).toBe(false);
    expect(res.error).toContain("mismatch");
  });

  it("blocks admin login attempts missing hardware key assertion", () => {
    const check = enforceAdminHardwareBinding("admin");
    expect(check.allowed).toBe(false);
    expect(check.error).toContain("hardware key");
  });

  it("allows non-admin logins without hardware key assertion", () => {
    const check = enforceAdminHardwareBinding("user");
    expect(check.allowed).toBe(true);
  });
});
