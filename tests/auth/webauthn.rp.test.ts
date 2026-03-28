describe("WebAuthn getRpConfig", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function setupMocksAndGetRpConfig() {
    // { virtual: true } tells Jest not to resolve the module on disk
    jest.doMock("@simplewebauthn/server", () => ({
      generateRegistrationOptions: jest.fn(),
      verifyRegistrationResponse: jest.fn(),
      generateAuthenticationOptions: jest.fn(),
      verifyAuthenticationResponse: jest.fn(),
    }), { virtual: true });
    jest.doMock("../../src/config/database", () => ({ pool: {} }));
    jest.doMock("../../src/config/redis", () => ({ redisClient: {} }));
    jest.doMock("../../src/utils/encryption", () => ({
      encrypt: jest.fn(),
      decrypt: jest.fn(),
    }));

    const { getRpConfig } = require("../../src/auth/webauthn");
    return getRpConfig;
  }

  it("returns defaults when env vars are not set", () => {
    delete process.env.WEBAUTHN_RP_NAME;
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_ORIGIN;

    const getRpConfig = setupMocksAndGetRpConfig();
    const config = getRpConfig();

    expect(config.rpName).toBe("Mobile Money App");
    expect(config.rpID).toBe("localhost");
    expect(config.origin).toBe("http://localhost:3000");
  });

  it("uses custom env vars when provided", () => {
    process.env.WEBAUTHN_RP_NAME = "My FinApp";
    process.env.WEBAUTHN_RP_ID = "finapp.io";
    process.env.WEBAUTHN_ORIGIN = "https://finapp.io";

    const getRpConfig = setupMocksAndGetRpConfig();
    const config = getRpConfig();

    expect(config.rpName).toBe("My FinApp");
    expect(config.rpID).toBe("finapp.io");
    expect(config.origin).toBe("https://finapp.io");
  });
});
