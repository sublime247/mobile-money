import * as StellarSdk from "stellar-sdk";
import { pool } from "../../config/database";
import { encrypt, decrypt } from "../../utils/encryption";
import { ensureTrustlines } from "../../stellar/trustlines";
import { createUser } from "../userService";

jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../utils/encryption", () => ({
  encrypt: jest.fn((text) => `encrypted:${text}`),
  decrypt: jest.fn((text) => text?.replace("encrypted:", "")),
}));

jest.mock("stellar-sdk", () => {
  const original = jest.requireActual("stellar-sdk");
  return {
    ...original,
    Keypair: {
      ...original.Keypair,
      random: jest.fn().mockReturnValue({
        publicKey: () => "GUSER_GENERATED...",
        secret: () => "SUSER_GENERATED...",
      }),
      fromSecret: jest.fn().mockReturnValue({
        publicKey: () => "GSPONSOR...",
        secret: () => "SSPONSOR...",
      }),
    },
  };
});

jest.mock("../../stellar/trustlines", () => ({
  ensureTrustlines: jest.fn(),
}));

jest.mock("../stellar/assetService", () => ({
  getConfiguredPaymentAsset: jest.fn().mockReturnValue({
    isNative: () => false,
    getCode: () => "USDC",
    getIssuer: () => "GD6O2RZ3LQONSN5YZC6M5X5TKUVXVAHPXFTDHADBXRN2PN5EA7CUUJJW",
  }),
}));

describe("UserService - createUser", () => {
  const mockPhone = "+123456789";
  const mockRoleId = "role-123";
  const TEST_SECRET = "SAQW679XU7X6X7X6X7X6X7X6X7X6X7X6X7X6X7X6X7X6X7X6X7X6X7X6";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_ISSUER_SECRET = TEST_SECRET;
  });

  it("should generate a Stellar Keypair and call ensureTrustlines for new users", async () => {
    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: mockRoleId }] })
      .mockResolvedValueOnce({
        rows: [{
          id: "user-123",
          phone_number: `encrypted:${mockPhone}`,
          kyc_level: "unverified",
          role_id: mockRoleId,
          stellar_address: "GUSER...",
          encrypted_seed: "encrypted:SUSER...",
          created_at: new Date(),
          updated_at: new Date(),
        }]
      });

    (ensureTrustlines as jest.Mock).mockResolvedValue({
      alreadyTrusted: [],
      created: [{ getCode: () => "USDC" }],
      failed: [],
    });

    const user = await createUser({ phone_number: mockPhone });

    expect(user.stellar_address).toBeDefined();
    expect(ensureTrustlines).toHaveBeenCalled();
  });

  it("should handle trustline fulfillment failures gracefully without throwing", async () => {
    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: mockRoleId }] })
      .mockResolvedValueOnce({
        rows: [{
          id: "user-123",
          phone_number: `encrypted:${mockPhone}`,
          kyc_level: "unverified",
          role_id: mockRoleId,
          stellar_address: "GUSER...",
          encrypted_seed: "encrypted:SUSER...",
          created_at: new Date(),
          updated_at: new Date(),
        }]
      });

    (ensureTrustlines as jest.Mock).mockRejectedValue(new Error("Stellar Horizon Error"));

    const user = await createUser({ phone_number: mockPhone });

    expect(user.id).toBe("user-123");
    expect(ensureTrustlines).toHaveBeenCalled();
  });
});
