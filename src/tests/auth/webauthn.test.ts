/**
 * Tests for the WebAuthn service and controller.
 *
 * The @simplewebauthn/server library and the DB/Redis dependencies are mocked
 * so the tests run without a real database or Redis instance.
 */

import { Request, Response } from "express";
import { authController } from "../../controllers/authController";

// ─── Mock @simplewebauthn/server ──────────────────────────────────────────────

jest.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: jest.fn().mockResolvedValue({
    challenge: "mock-reg-challenge",
    rp: { name: "Mobile Money Admin", id: "localhost" },
    user: { id: "dXNlcmlk", name: "test-user", displayName: "test-user" },
    pubKeyCredParams: [],
    timeout: 60000,
    excludeCredentials: [],
    authenticatorSelection: {},
    attestation: "none",
  }),
  verifyRegistrationResponse: jest.fn().mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: {
        id: "mock-credential-id",
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ["usb"],
      },
    },
  }),
  generateAuthenticationOptions: jest.fn().mockResolvedValue({
    challenge: "mock-auth-challenge",
    rpId: "localhost",
    allowCredentials: [],
    userVerification: "preferred",
    timeout: 60000,
  }),
  verifyAuthenticationResponse: jest.fn().mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  }),
}));

// ─── Mock DB helpers ──────────────────────────────────────────────────────────

jest.mock("../../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

jest.mock("../../config/redis", () => ({
  redisClient: {
    setEx: jest.fn().mockResolvedValue("OK"),
    get: jest.fn().mockResolvedValue("mock-reg-challenge"),
    del: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock("../../services/userService", () => ({
  getUserById: jest.fn().mockResolvedValue({
    id: "user-uuid-1234",
    phone_number: "+237670000000",
  }),
}));

// ─── Mock the WebAuthn service functions directly ─────────────────────────────
// (so controller tests don't need full DB rows)

jest.mock("../../services/auth/webauthn", () => ({
  generateRegistrationChallenge: jest.fn().mockResolvedValue({
    options: { challenge: "mock-reg-challenge" },
  }),
  verifyAndSaveCredential: jest.fn().mockResolvedValue({
    credential: {
      credential_id: "mock-credential-id",
      device_name: "YubiKey 5 NFC",
      created_at: new Date("2026-07-28T00:00:00Z"),
    },
    verified: true,
  }),
  generateAuthenticationChallenge: jest.fn().mockResolvedValue({
    options: { challenge: "mock-auth-challenge" },
  }),
  verifyAuthenticationAssertion: jest.fn().mockResolvedValue({
    verified: true,
    credentialId: "mock-credential-id",
    newSignCount: 1,
  }),
  getCredentialsByUserId: jest.fn().mockResolvedValue([
    {
      credential_id: "mock-credential-id",
      device_name: "YubiKey 5 NFC",
      created_at: new Date("2026-07-28T00:00:00Z"),
      last_used_at: null,
    },
  ]),
  removeCredential: jest.fn().mockResolvedValue(true),
  hasWebAuthnCredentials: jest.fn().mockResolvedValue(true),
}));

// ─── Utilities ────────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    jwtUser: { userId: "user-uuid-1234", email: "test@example.com", role: "admin" },
    body: {},
    params: {},
    query: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): { res: Response; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const res = { json, status } as unknown as Response;
  return { res, json, status };
}

// ─── Controller: Registration ─────────────────────────────────────────────────

describe("authController.getRegistrationChallenge", () => {
  it("returns challenge options for an authenticated user", async () => {
    const req = mockReq();
    const { res, json } = mockRes();

    await authController.getRegistrationChallenge(req, res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ challenge: "mock-reg-challenge" }) }),
    );
  });

  it("returns 401 when no JWT is present", async () => {
    const req = mockReq({ jwtUser: undefined } as any);
    const { res, status } = mockRes();

    await authController.getRegistrationChallenge(req, res);

    expect(status).toHaveBeenCalledWith(401);
  });
});

describe("authController.completeRegistration", () => {
  it("returns 201 with credentialId on valid response", async () => {
    const req = mockReq({
      body: {
        response: { id: "mock-credential-id", rawId: "mock-credential-id" },
        deviceName: "YubiKey 5 NFC",
      },
    });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.completeRegistration(req, res);

    expect(status).toHaveBeenCalledWith(201);
    expect(statusJson).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Hardware key registered successfully",
        credentialId: "mock-credential-id",
      }),
    );
  });

  it("returns 400 when request body is invalid", async () => {
    const req = mockReq({ body: null });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.completeRegistration(req, res);

    expect(status).toHaveBeenCalledWith(400);
  });

  it("returns 400 when challenge has expired", async () => {
    const { verifyAndSaveCredential } = require("../../services/auth/webauthn");
    (verifyAndSaveCredential as jest.Mock).mockRejectedValueOnce(
      new Error("Registration challenge expired or not found"),
    );

    const req = mockReq({
      body: { response: { id: "mock-credential-id" } },
    });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.completeRegistration(req, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(statusJson).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Hardware key registration failed" }),
    );
  });
});

// ─── Controller: List / Delete credentials ───────────────────────────────────

describe("authController.listCredentials", () => {
  it("returns the list of registered keys", async () => {
    const req = mockReq();
    const { res, json } = mockRes();

    await authController.listCredentials(req, res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.arrayContaining([
          expect.objectContaining({ credentialId: "mock-credential-id" }),
        ]),
      }),
    );
  });
});

describe("authController.deleteCredential", () => {
  it("returns success message when credential is deleted", async () => {
    const req = mockReq({ params: { credentialId: "mock-credential-id" } });
    const { res, json } = mockRes();

    await authController.deleteCredential(req, res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Hardware key removed successfully" }),
    );
  });

  it("returns 404 when credential not found", async () => {
    const { removeCredential } = require("../../services/auth/webauthn");
    (removeCredential as jest.Mock).mockResolvedValueOnce(false);

    const req = mockReq({ params: { credentialId: "non-existent" } });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.deleteCredential(req, res);

    expect(status).toHaveBeenCalledWith(404);
  });

  it("returns 400 when credentialId param is missing", async () => {
    const req = mockReq({ params: {} });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.deleteCredential(req, res);

    expect(status).toHaveBeenCalledWith(400);
  });
});

// ─── Controller: Authentication ───────────────────────────────────────────────

describe("authController.getAuthenticationChallenge", () => {
  it("returns challenge options when userId is provided", async () => {
    const req = mockReq({ query: { userId: "user-uuid-1234" } });
    const { res, json } = mockRes();

    await authController.getAuthenticationChallenge(req, res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ challenge: "mock-auth-challenge" }) }),
    );
  });

  it("returns 400 when userId query param is missing", async () => {
    const req = mockReq({ query: {} });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.getAuthenticationChallenge(req, res);

    expect(status).toHaveBeenCalledWith(400);
  });

  it("returns 400 when no hardware keys are registered", async () => {
    const { generateAuthenticationChallenge } = require("../../services/auth/webauthn");
    (generateAuthenticationChallenge as jest.Mock).mockRejectedValueOnce(
      new Error("No hardware keys registered for this user. Complete registration first."),
    );

    const req = mockReq({ query: { userId: "user-uuid-1234" } });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.getAuthenticationChallenge(req, res);

    expect(status).toHaveBeenCalledWith(400);
  });
});

// Valid UUID used across authentication tests
const VALID_USER_UUID = "a1b2c3d4-e5f6-4789-abcd-ef1234567890";

describe("authController.verifyAuthentication", () => {
  it("returns verified:true on a valid hardware-key assertion", async () => {
    const req = mockReq({
      body: {
        userId: VALID_USER_UUID,
        response: { id: "mock-credential-id", rawId: "mock-credential-id" },
      },
    });
    const { res, json } = mockRes();

    await authController.verifyAuthentication(req, res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true }),
    );
  });

  // ── Acceptance criterion: Block login attempts missing token codes ──────
  it("returns 401 (blocks login) when assertion verification fails", async () => {
    const { verifyAuthenticationAssertion } = require("../../services/auth/webauthn");
    (verifyAuthenticationAssertion as jest.Mock).mockRejectedValueOnce(
      new Error("WebAuthn authentication verification failed"),
    );

    const req = mockReq({
      body: {
        userId: VALID_USER_UUID,
        response: { id: "bad-credential" },
      },
    });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.verifyAuthentication(req, res);

    expect(status).toHaveBeenCalledWith(401);
    expect(statusJson).toHaveBeenCalledWith(
      expect.objectContaining({ verified: false }),
    );
  });

  it("returns 401 when challenge is expired (blocks login)", async () => {
    const { verifyAuthenticationAssertion } = require("../../services/auth/webauthn");
    (verifyAuthenticationAssertion as jest.Mock).mockRejectedValueOnce(
      new Error("Authentication challenge expired or not found"),
    );

    const req = mockReq({
      body: {
        userId: VALID_USER_UUID,
        response: { id: "mock-credential-id" },
      },
    });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.verifyAuthentication(req, res);

    expect(status).toHaveBeenCalledWith(401);
  });

  it("returns 401 when credential belongs to a different user (blocks login)", async () => {
    const { verifyAuthenticationAssertion } = require("../../services/auth/webauthn");
    (verifyAuthenticationAssertion as jest.Mock).mockRejectedValueOnce(
      new Error("Credential not found or does not belong to this user"),
    );

    const req = mockReq({
      body: {
        userId: VALID_USER_UUID,
        response: { id: "other-users-credential" },
      },
    });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.verifyAuthentication(req, res);

    expect(status).toHaveBeenCalledWith(401);
  });

  it("returns 400 when body fails schema validation (userId not a UUID)", async () => {
    const req = mockReq({ body: { userId: "not-a-uuid", response: {} } });
    const { res, status } = mockRes();
    const statusJson = jest.fn();
    (status as jest.Mock).mockReturnValue({ json: statusJson });

    await authController.verifyAuthentication(req, res);

    expect(status).toHaveBeenCalledWith(400);
  });
});
