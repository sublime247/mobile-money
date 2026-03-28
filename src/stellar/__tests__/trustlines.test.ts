import * as StellarSdk from "stellar-sdk";
import {
  hasTrustline,
  createTrustline,
  createSponsoredTrustline,
  removeTrustline,
  ensureTrustlines,
} from "../trustlines";

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("../../config/stellar", () => ({
  getStellarServer: jest.fn(),
  getNetworkPassphrase: jest.fn().mockReturnValue("Test SDF Network ; September 2015"),
}));

import { getStellarServer } from "../../config/stellar";

const mockSubmitTransaction = jest.fn();
const mockLoadAccount = jest.fn();

const mockServer = {
  loadAccount: mockLoadAccount,
  submitTransaction: mockSubmitTransaction,
};

beforeEach(() => {
  jest.clearAllMocks();
  (getStellarServer as jest.Mock).mockReturnValue(mockServer);
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUER = StellarSdk.Keypair.random().publicKey();
const USDC    = new StellarSdk.Asset("USDC", ISSUER);
const XAF     = new StellarSdk.Asset("XAF",  ISSUER);
const XLM     = StellarSdk.Asset.native();

const userKeypair    = StellarSdk.Keypair.random();
const sponsorKeypair = StellarSdk.Keypair.random();

/** Minimal Horizon account with a single USDC trustline. */
function makeAccount(
  publicKey: string,
  trustedAssets: StellarSdk.Asset[] = [],
): StellarSdk.Horizon.AccountResponse {
  const balances: StellarSdk.Horizon.HorizonApi.BalanceLine[] = [
    { asset_type: "native", balance: "10.0000000" } as StellarSdk.Horizon.HorizonApi.BalanceLine<"native">,
    ...trustedAssets.map((asset) => ({
      asset_type: asset.getCode().length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
      asset_code: asset.getCode(),
      asset_issuer: asset.getIssuer(),
      balance: "0.0000000",
      limit: "922337203685.4775807",
    } as StellarSdk.Horizon.HorizonApi.BalanceLine<"credit_alphanum4">)),
  ];

  return {
    id: publicKey,
    account_id: publicKey,
    balances,
    sequence: "1",
    sequenceNumber: () => "1",
    accountId: () => publicKey,
    incrementSequenceNumber: () => {},
  } as unknown as StellarSdk.Horizon.AccountResponse;
}

const TX_RESULT = { hash: "abc123", ledger: 42 };

// ── hasTrustline ──────────────────────────────────────────────────────────────

describe("hasTrustline", () => {
  it("returns true for native XLM without calling Horizon", async () => {
    const result = await hasTrustline(userKeypair.publicKey(), XLM);
    expect(result).toBe(true);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("returns true when the account has the trustline", async () => {
    mockLoadAccount.mockResolvedValue(
      makeAccount(userKeypair.publicKey(), [USDC]),
    );
    expect(await hasTrustline(userKeypair.publicKey(), USDC)).toBe(true);
  });

  it("returns false when the trustline is missing", async () => {
    mockLoadAccount.mockResolvedValue(makeAccount(userKeypair.publicKey()));
    expect(await hasTrustline(userKeypair.publicKey(), USDC)).toBe(false);
  });

  it("returns false when the account does not exist on-chain", async () => {
    mockLoadAccount.mockRejectedValue({ response: { status: 404 } });
    expect(await hasTrustline(userKeypair.publicKey(), USDC)).toBe(false);
  });

  it("rethrows unexpected Horizon errors", async () => {
    mockLoadAccount.mockRejectedValue(new Error("network timeout"));
    await expect(hasTrustline(userKeypair.publicKey(), USDC)).rejects.toThrow(
      "network timeout",
    );
  });
});

// ── createTrustline ───────────────────────────────────────────────────────────

describe("createTrustline", () => {
  it("submits a ChangeTrust operation and returns hash + ledger", async () => {
    mockLoadAccount.mockResolvedValue(makeAccount(userKeypair.publicKey()));
    mockSubmitTransaction.mockResolvedValue(TX_RESULT);

    const result = await createTrustline({
      accountKeypair: userKeypair,
      asset: USDC,
    });

    expect(result).toEqual(TX_RESULT);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);

    // Verify the submitted tx contains exactly one ChangeTrust operation
    const tx = mockSubmitTransaction.mock.calls[0][0] as StellarSdk.Transaction;
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("changeTrust");
  });

  it("uses the provided limit instead of the default", async () => {
    mockLoadAccount.mockResolvedValue(makeAccount(userKeypair.publicKey()));
    mockSubmitTransaction.mockResolvedValue(TX_RESULT);

    await createTrustline({ accountKeypair: userKeypair, asset: USDC, limit: "1000" });

    const tx = mockSubmitTransaction.mock.calls[0][0] as StellarSdk.Transaction;
    const op = tx.operations[0] as StellarSdk.Operation.ChangeTrust;
    expect(op.limit).toBe("1000.0000000");
  });
});

// ── createSponsoredTrustline ──────────────────────────────────────────────────

describe("createSponsoredTrustline", () => {
  it("wraps ChangeTrust in a sponsorship envelope with 3 operations", async () => {
    mockLoadAccount.mockResolvedValue(makeAccount(sponsorKeypair.publicKey()));
    mockSubmitTransaction.mockResolvedValue(TX_RESULT);

    const result = await createSponsoredTrustline({
      accountKeypair: userKeypair,
      sponsorKeypair,
      asset: XAF,
    });

    expect(result).toEqual(TX_RESULT);

    const tx = mockSubmitTransaction.mock.calls[0][0] as StellarSdk.Transaction;
    expect(tx.operations).toHaveLength(3);
    expect(tx.operations[0].type).toBe("beginSponsoringFutureReserves");
    expect(tx.operations[1].type).toBe("changeTrust");
    expect(tx.operations[2].type).toBe("endSponsoringFutureReserves");
  });

  it("sets the ChangeTrust source to the user's account, not the sponsor's", async () => {
    mockLoadAccount.mockResolvedValue(makeAccount(sponsorKeypair.publicKey()));
    mockSubmitTransaction.mockResolvedValue(TX_RESULT);

    await createSponsoredTrustline({
      accountKeypair: userKeypair,
      sponsorKeypair,
      asset: XAF,
    });

    const tx = mockSubmitTransaction.mock.calls[0][0] as StellarSdk.Transaction;
    const changeTrustOp = tx.operations[1];
    expect(changeTrustOp.source).toBe(userKeypair.publicKey());
  });
});

// ── removeTrustline ───────────────────────────────────────────────────────────

describe("removeTrustline", () => {
  it("submits a ChangeTrust with limit '0'", async () => {
    mockLoadAccount.mockResolvedValue(makeAccount(userKeypair.publicKey(), [USDC]));
    mockSubmitTransaction.mockResolvedValue(TX_RESULT);

    await removeTrustline({ accountKeypair: userKeypair, asset: USDC });

    const tx = mockSubmitTransaction.mock.calls[0][0] as StellarSdk.Transaction;
    const op = tx.operations[0] as StellarSdk.Operation.ChangeTrust;
    expect(op.limit).toBe("0.0000000");
  });
});

// ── ensureTrustlines ──────────────────────────────────────────────────────────

describe("ensureTrustlines", () => {
  it("skips assets that already have trustlines", async () => {
    mockLoadAccount.mockResolvedValue(
      makeAccount(userKeypair.publicKey(), [USDC, XAF]),
    );

    const result = await ensureTrustlines({
      accountKeypair: userKeypair,
      assets: [USDC, XAF],
    });

    expect(result.alreadyTrusted).toHaveLength(2);
    expect(result.created).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  it("creates trustlines for missing assets", async () => {
    // First call: hasTrustline check (no trustlines yet)
    // Second call: createTrustline loads account again
    mockLoadAccount
      .mockResolvedValueOnce(makeAccount(userKeypair.publicKey()))         // hasTrustline USDC
      .mockResolvedValueOnce(makeAccount(userKeypair.publicKey()))         // createTrustline USDC
      .mockResolvedValueOnce(makeAccount(userKeypair.publicKey()))         // hasTrustline XAF
      .mockResolvedValueOnce(makeAccount(userKeypair.publicKey()));        // createTrustline XAF

    mockSubmitTransaction.mockResolvedValue(TX_RESULT);

    const result = await ensureTrustlines({
      accountKeypair: userKeypair,
      assets: [USDC, XAF],
    });

    expect(result.created).toHaveLength(2);
    expect(result.alreadyTrusted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
  });

  it("uses sponsored flow when sponsored: true and sponsorKeypair provided", async () => {
    mockLoadAccount
      .mockResolvedValueOnce(makeAccount(userKeypair.publicKey()))         // hasTrustline
      .mockResolvedValueOnce(makeAccount(sponsorKeypair.publicKey()));     // createSponsoredTrustline

    mockSubmitTransaction.mockResolvedValue(TX_RESULT);

    await ensureTrustlines({
      accountKeypair: userKeypair,
      assets: [USDC],
      sponsored: true,
      sponsorKeypair,
    });

    const tx = mockSubmitTransaction.mock.calls[0][0] as StellarSdk.Transaction;
    // Sponsored flow has 3 operations
    expect(tx.operations).toHaveLength(3);
    expect(tx.operations[0].type).toBe("beginSponsoringFutureReserves");
  });

  it("collects failed assets without throwing and continues processing", async () => {
    mockLoadAccount
      .mockResolvedValueOnce(makeAccount(userKeypair.publicKey()))         // hasTrustline USDC
      .mockRejectedValueOnce(new Error("Horizon error"))                   // createTrustline USDC fails
      .mockResolvedValueOnce(makeAccount(userKeypair.publicKey()))         // hasTrustline XAF
      .mockResolvedValueOnce(makeAccount(userKeypair.publicKey()));        // createTrustline XAF

    mockSubmitTransaction.mockResolvedValue(TX_RESULT);

    const result = await ensureTrustlines({
      accountKeypair: userKeypair,
      assets: [USDC, XAF],
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].asset.getCode()).toBe("USDC");
    expect(result.created).toHaveLength(1);
    expect(result.created[0].getCode()).toBe("XAF");
  });

  it("places native XLM in alreadyTrusted without calling Horizon", async () => {
    const result = await ensureTrustlines({
      accountKeypair: userKeypair,
      assets: [XLM],
    });

    expect(result.alreadyTrusted).toHaveLength(1);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("throws immediately when sponsored is true but no sponsorKeypair given", async () => {
    await expect(
      ensureTrustlines({
        accountKeypair: userKeypair,
        assets: [USDC],
        sponsored: true,
      }),
    ).rejects.toThrow("sponsorKeypair must be provided");
  });

  it("handles empty asset list gracefully", async () => {
    const result = await ensureTrustlines({
      accountKeypair: userKeypair,
      assets: [],
    });

    expect(result.alreadyTrusted).toHaveLength(0);
    expect(result.created).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });
});