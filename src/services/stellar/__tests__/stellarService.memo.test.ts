import * as StellarSdk from "@stellar/stellar-sdk";

const issuer = StellarSdk.Keypair.random();
const destination = StellarSdk.Keypair.random().publicKey();
const submitted: StellarSdk.Transaction[] = [];

jest.mock("../../../config/stellar", () => ({
  getStellarServer: () => ({
    loadAccount: jest.fn(
      async (id: string) =>
        new (jest.requireActual("@stellar/stellar-sdk").Account)(id, "100"),
    ),
    feeStats: jest.fn(async () => ({ fee_charged: { p90: "100" } })),
    submitTransaction: jest.fn(async (tx: StellarSdk.Transaction) => {
      submitted.push(tx);
      return { hash: "abc", ledger: 1 };
    }),
  }),
  getNetworkPassphrase: () => "Test SDF Network ; September 2015",
}));

jest.mock("../../sanctionService", () => ({
  sanctionService: {
    checkParties: jest.fn(),
    checkPartiesByAddress: jest.fn(),
  },
}));

jest.mock("../assetService", () => ({
  AssetService: jest.fn().mockImplementation(() => ({
    hasTrustline: jest.fn().mockResolvedValue(true),
  })),
  getConfiguredPaymentAsset: () => StellarSdk.Asset.native(),
}));

import { StellarService } from "../stellarService";

describe("StellarService.sendPayment — memo", () => {
  const env = process.env.STELLAR_ISSUER_SECRET;

  beforeEach(() => {
    submitted.length = 0;
    process.env.STELLAR_ISSUER_SECRET = issuer.secret();
  });

  afterAll(() => {
    process.env.STELLAR_ISSUER_SECRET = env;
  });

  it("attaches the memo to the submitted payment", async () => {
    const service = new StellarService();

    await service.sendPayment(
      destination,
      "10",
      undefined,
      undefined,
      false,
      StellarSdk.Memo.id("987654321"),
    );

    expect(submitted).toHaveLength(1);
    expect(submitted[0].memo.type).toBe("id");
    expect(submitted[0].memo.value).toBe("987654321");
  });

  it("sends no memo when none is given", async () => {
    const service = new StellarService();

    await service.sendPayment(destination, "10");

    expect(submitted[0].memo.type).toBe("none");
  });
});
