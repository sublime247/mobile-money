const mockPoolQuery = jest.fn();

jest.mock("../../config/database", () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

import { AnchoredAssetModel } from "../anchoredAsset";
import {
  encryptSecret,
  decryptSecret,
  isEncryptedValue,
} from "../../utils/crypto";

describe("AnchoredAssetModel credential encryption (#2031)", () => {
  const model = new AnchoredAssetModel();

  const issuerSecret =
    ("S" + "TEST0000ISSUER".padEnd(55, "0"));
  const distributionSecret =
    ("S" + "TEST0000DISTRIB".padEnd(55, "0"));

  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it("encrypts issuer and distribution seed keys before insert", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await model.insert({
      assetCode: "USDX",
      issuerPublicKey: "GISSUER",
      issuerSecretKey: issuerSecret,
      distributionPublicKey: "GDIST",
      distributionSecretKey: distributionSecret,
      issuanceLimit: "1000000",
      status: "active",
      metadata: { name: "USDX" },
    });

    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    const storedIssuer = params[3] as string;
    const storedDistribution = params[5] as string;

    expect(storedIssuer).not.toBe(issuerSecret);
    expect(storedDistribution).not.toBe(distributionSecret);
    expect(isEncryptedValue(storedIssuer)).toBe(true);
    expect(isEncryptedValue(storedDistribution)).toBe(true);
    expect(decryptSecret(storedIssuer)).toBe(issuerSecret);
    expect(decryptSecret(storedDistribution)).toBe(distributionSecret);
  });

  it("does not double-encrypt already-encrypted secret keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const encryptedIssuer = encryptSecret(issuerSecret);
    await model.insert({
      assetCode: "USDX",
      issuerPublicKey: "GISSUER",
      issuerSecretKey: encryptedIssuer!,
      distributionPublicKey: "GDIST",
      distributionSecretKey: encryptSecret(distributionSecret)!,
      issuanceLimit: "1000000",
      status: "active",
      metadata: {},
    });

    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(params[3]).toBe(encryptedIssuer);
    expect(decryptSecret(params[3] as string)).toBe(issuerSecret);
  });

  it("decrypts seed keys transparently when loading assets", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "asset-1",
          assetCode: "USDX",
          issuerPublicKey: "GISSUER",
          issuerSecretKey: encryptSecret(issuerSecret),
          distributionPublicKey: "GDIST",
          distributionSecretKey: encryptSecret(distributionSecret),
          issuanceLimit: "1000000",
          status: "active",
          metadata: {},
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });

    const assets = await model.findAll();

    expect(assets).toHaveLength(1);
    expect(assets[0].issuerSecretKey).toBe(issuerSecret);
    expect(assets[0].distributionSecretKey).toBe(distributionSecret);
  });

  it("keeps legacy plaintext secret keys readable", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "asset-legacy",
          assetCode: "OLDX",
          issuerPublicKey: "GISSUER",
          issuerSecretKey: issuerSecret,
          distributionPublicKey: "GDIST",
          distributionSecretKey: distributionSecret,
          issuanceLimit: "1",
          status: "active",
          metadata: {},
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
          updatedAt: new Date("2025-01-01T00:00:00.000Z"),
        },
      ],
    });

    const asset = await model.findByCode("OLDX");
    expect(asset?.issuerSecretKey).toBe(issuerSecret);
  });
});
