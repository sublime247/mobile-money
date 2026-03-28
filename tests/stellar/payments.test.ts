import * as StellarSdk from "stellar-sdk";
import {
  executePathPayment,
  findPaymentPaths,
  SlippageError,
} from "../../../src/stellar/payments";

// ── shared fixtures ──────────────────────────────────────────────────────────
const senderKeypair = StellarSdk.Keypair.random();
const destKeypair = StellarSdk.Keypair.random();
const usdcIssuer = StellarSdk.Keypair.random().publicKey();
const usdc = new StellarSdk.Asset("USDC", usdcIssuer);
const xafIssuer = StellarSdk.Keypair.random().publicKey();
const xaf = new StellarSdk.Asset("XAF", xafIssuer);

// ── mock Horizon server ──────────────────────────────────────────────────────
const mockSubmit = jest.fn();
const mockLoadAccount = jest.fn();
const mockStrictReceivePaths = jest.fn();

jest.mock("../../src/config/stellar", () => ({
  getStellarServer: () => ({
    loadAccount: mockLoadAccount,
    submitTransaction: mockSubmit,
    strictReceivePaths: mockStrictReceivePaths,
  }),
  getNetworkPassphrase: () => StellarSdk.Networks.TESTNET,
}));

// ── mock AssetService ────────────────────────────────────────────────────────
const mockHasTrustline = jest.fn().mockResolvedValue(true);
jest.mock("../../src/services/stellar/assetService", () => ({
  AssetService: jest.fn().mockImplementation(() => ({
    hasTrustline: mockHasTrustline,
  })),
}));

// ── helpers ──────────────────────────────────────────────────────────────────
function makeAccount() {
  return new StellarSdk.Account(senderKeypair.publicKey(), "100");
}

// ── tests ────────────────────────────────────────────────────────────────────
describe("findPaymentPaths", () => {
  it("returns paths matching the destination asset", async () => {
    const record = {
      destination_asset_type: "credit_alphanum4",
      destination_asset_code: "USDC",
      destination_asset_issuer: usdcIssuer,
    };
    mockStrictReceivePaths.mockReturnValue({
      call: jest.fn().mockResolvedValue({ records: [record] }),
    });

    const paths = await findPaymentPaths(
      xaf,
      usdc,
      "10",
      destKeypair.publicKey(),
    );
    expect(paths).toHaveLength(1);
    expect(paths[0].destination_asset_code).toBe("USDC");
  });

  it("filters out paths for a different destination asset", async () => {
    const record = {
      destination_asset_type: "credit_alphanum4",
      destination_asset_code: "BTC",
      destination_asset_issuer: usdcIssuer,
    };
    mockStrictReceivePaths.mockReturnValue({
      call: jest.fn().mockResolvedValue({ records: [record] }),
    });

    const paths = await findPaymentPaths(
      xaf,
      usdc,
      "10",
      destKeypair.publicKey(),
    );
    expect(paths).toHaveLength(0);
  });
});

describe("executePathPayment", () => {
  const baseParams = {
    senderKeypair,
    destination: destKeypair.publicKey(),
    sendAsset: xaf,
    destAsset: usdc,
    destAmount: "10",
    sendMax: "600",
  };

  beforeEach(() => {
    mockLoadAccount.mockResolvedValue(makeAccount());
    mockHasTrustline.mockResolvedValue(true);
  });

  it("returns hash and ledger on success", async () => {
    mockSubmit.mockResolvedValue({ hash: "abc123", ledger: 42 });

    const result = await executePathPayment(baseParams);
    expect(result.hash).toBe("abc123");
    expect(result.ledger).toBe(42);
  });

  it("throws SlippageError when op_over_sendmax is returned", async () => {
    mockSubmit.mockRejectedValue({
      response: {
        data: {
          extras: { result_codes: { operations: ["op_over_sendmax"] } },
        },
      },
    });

    await expect(executePathPayment(baseParams)).rejects.toBeInstanceOf(
      SlippageError,
    );
  });

  it("re-throws non-slippage errors unchanged", async () => {
    const networkErr = new Error("network timeout");
    mockSubmit.mockRejectedValue(networkErr);

    await expect(executePathPayment(baseParams)).rejects.toBe(networkErr);
  });

  it("throws when destination has no trustline for destAsset", async () => {
    mockHasTrustline.mockResolvedValue(false);

    await expect(executePathPayment(baseParams)).rejects.toThrow(
      /no trustline/,
    );
  });

  it("skips trustline check for native destAsset", async () => {
    mockSubmit.mockResolvedValue({ hash: "native_hash", ledger: 1 });

    const result = await executePathPayment({
      ...baseParams,
      destAsset: StellarSdk.Asset.native(),
    });
    expect(mockHasTrustline).not.toHaveBeenCalled();
    expect(result.hash).toBe("native_hash");
  });
});
