import * as StellarSdk from "@stellar/stellar-sdk";

const issuer = StellarSdk.Keypair.random();
const channelKeys = [StellarSdk.Keypair.random(), StellarSdk.Keypair.random()];
const sequences = new Map<string, bigint>();
const submitted: StellarSdk.Transaction[] = [];

jest.mock("../../../config/stellar", () => {
  const sdk = jest.requireActual("@stellar/stellar-sdk");
  return {
    getStellarServer: () => ({
      loadAccount: jest.fn(async (id: string) => ({
        ...new sdk.Account(id, sequences.get(id)!.toString()),
        sequenceNumber: () => sequences.get(id)!.toString(),
        accountId: () => id,
        incrementSequenceNumber: () => undefined,
        balances: [{ asset_type: "native", balance: "100" }],
      })),
      feeStats: jest.fn(async () => ({ fee_charged: { p90: "100" } })),
      submitTransaction: jest.fn(async (tx: StellarSdk.Transaction) => {
        await new Promise((r) => setTimeout(r, 2));
        const current = sequences.get(tx.source)!;
        if (BigInt(tx.sequence) !== current + 1n) {
          throw new Error("Transaction failed: tx_bad_seq");
        }
        sequences.set(tx.source, current + 1n);
        submitted.push(tx);
        return { hash: tx.hash().toString("hex"), ledger: 1 };
      }),
    }),
    getNetworkPassphrase: () => sdk.Networks.TESTNET,
  };
});

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
import { resetChannelPool } from "../../channelPool";

describe("StellarService.sendPayment — channel account pool", () => {
  const env = { ...process.env };
  const destination = StellarSdk.Keypair.random().publicKey();

  beforeEach(() => {
    submitted.length = 0;
    sequences.clear();
    sequences.set(issuer.publicKey(), 1n);
    for (const kp of channelKeys) sequences.set(kp.publicKey(), 100n);
    process.env.STELLAR_ISSUER_SECRET = issuer.secret();
    resetChannelPool();
  });

  afterEach(() => {
    resetChannelPool();
    process.env = { ...env };
  });

  it("sends concurrent payments through channels without sequence collisions", async () => {
    process.env.STELLAR_CHANNEL_POOL_ACCOUNTS = JSON.stringify(
      channelKeys.map((kp) => ({
        publicKey: kp.publicKey(),
        secretKey: kp.secret(),
      })),
    );
    const service = new StellarService();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.sendPayment(destination, "1")),
    );

    expect(results.every((r) => typeof r.hash === "string")).toBe(true);
    expect(submitted).toHaveLength(8);
    const channelIds = channelKeys.map((kp) => kp.publicKey());
    for (const tx of submitted) {
      // Channel pays the fee and sequence; the issuer still funds the payment.
      expect(channelIds).toContain(tx.source);
      expect(tx.operations[0].source).toBe(issuer.publicKey());
      expect(tx.signatures).toHaveLength(2);
    }
    // The issuer's own sequence is untouched.
    expect(sequences.get(issuer.publicKey())).toBe(1n);
  });

  it("keeps the payment memo when sending through a channel", async () => {
    process.env.STELLAR_CHANNEL_POOL_ACCOUNTS = JSON.stringify(
      channelKeys.map((kp) => ({
        publicKey: kp.publicKey(),
        secretKey: kp.secret(),
      })),
    );
    const service = new StellarService();

    await service.sendPayment(
      destination,
      "1",
      undefined,
      undefined,
      false,
      StellarSdk.Memo.id("42"),
    );

    expect(submitted[0].memo.type).toBe("id");
    expect(submitted[0].memo.value).toBe("42");
  });

  it("submits from the issuer when no channels are configured", async () => {
    delete process.env.STELLAR_CHANNEL_POOL_ACCOUNTS;
    const service = new StellarService();

    await service.sendPayment(destination, "1");

    expect(submitted[0].source).toBe(issuer.publicKey());
    expect(submitted[0].operations[0].source).toBeUndefined();
  });
});
