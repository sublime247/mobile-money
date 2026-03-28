import * as StellarSdk from "stellar-sdk";
import {
  findPaymentPaths,
  executePathPayment,
  SlippageError,
  PathPaymentParams,
} from "../payments";

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("../../config/stellar", () => ({
  getStellarServer: jest.fn(),
  getNetworkPassphrase: jest.fn(() => StellarSdk.Networks.TESTNET),
}));

jest.mock("../../services/stellar/assetService", () => ({
  AssetService: jest.fn().mockImplementation(() => ({
    hasTrustline: jest.fn().mockResolvedValue(true),
  })),
}));

import { getStellarServer } from "../../config/stellar";
import { AssetService } from "../../services/stellar/assetService";

const mockGetStellarServer = getStellarServer as jest.Mock;
const mockAssetService     = AssetService as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const XAF_ISSUER  = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const xafAsset  = new StellarSdk.Asset("XAF",  XAF_ISSUER);
const usdcAsset = new StellarSdk.Asset("USDC", USDC_ISSUER);

const senderKeypair      = StellarSdk.Keypair.random();
const destinationAccount = StellarSdk.Keypair.random().publicKey();

/** A minimal path record returned by Horizon's strict-receive endpoint. */
function makePathRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source_asset_type:          "credit_alphanum4",
    source_asset_code:          xafAsset.getCode(),
    source_asset_issuer:        xafAsset.getIssuer(),
    source_amount:              "500.0000000",
    destination_asset_type:     "credit_alphanum4",
    destination_asset_code:     usdcAsset.getCode(),
    destination_asset_issuer:   usdcAsset.getIssuer(),
    destination_amount:         "5.0000000",
    path:                       [],
    ...overrides,
  };
}

/** Build a minimal mock Horizon server. */
function mockServer(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const submitTransaction = jest.fn().mockResolvedValue({
    hash:   "txhash123",
    ledger: 55,
  });

  const strictReceivePaths = jest.fn().mockReturnValue({
    call: jest.fn().mockResolvedValue({ records: [makePathRecord()] }),
  });

  const loadAccount = jest.fn().mockResolvedValue({
    account_id:              senderKeypair.publicKey(),
    sequence:                "1000",
    incrementSequenceNumber: jest.fn(),
    balances:                [],
  });

  return {
    strictReceivePaths,
    loadAccount,
    submitTransaction,
    ...overrides,
  };
}

/** Default params for executePathPayment. */
function makeParams(overrides: Partial<PathPaymentParams> = {}): PathPaymentParams {
  return {
    senderKeypair,
    destination:  destinationAccount,
    sendAsset:    xafAsset,
    destAsset:    usdcAsset,
    destAmount:   "5",
    sendMax:      "600",
    ...overrides,
  };
}

// ── findPaymentPaths ──────────────────────────────────────────────────────────

describe("findPaymentPaths", () => {
  it("returns records whose destination asset matches destAsset", async () => {
    const server = mockServer();
    mockGetStellarServer.mockReturnValue(server);

    const paths = await findPaymentPaths(
      xafAsset,
      usdcAsset,
      "5",
      destinationAccount,
    );

    expect(server.strictReceivePaths).toHaveBeenCalledWith(
      xafAsset,
      "5",
      [destinationAccount],
    );
    expect(paths).toHaveLength(1);
    expect(paths[0].destination_asset_code).toBe("USDC");
  });

  it("filters out records whose destination asset does not match", async () => {
    const wrongRecord = makePathRecord({
      destination_asset_code:   "XLM",
      destination_asset_type:   "native",
      destination_asset_issuer: undefined,
    });

    const server = mockServer({
      strictReceivePaths: jest.fn().mockReturnValue({
        call: jest.fn().mockResolvedValue({ records: [wrongRecord] }),
      }),
    });
    mockGetStellarServer.mockReturnValue(server);

    const paths = await findPaymentPaths(
      xafAsset,
      usdcAsset,
      "5",
      destinationAccount,
    );

    expect(paths).toHaveLength(0);
  });

  it("returns an empty array when Horizon returns no paths", async () => {
    const server = mockServer({
      strictReceivePaths: jest.fn().mockReturnValue({
        call: jest.fn().mockResolvedValue({ records: [] }),
      }),
    });
    mockGetStellarServer.mockReturnValue(server);

    const paths = await findPaymentPaths(
      xafAsset,
      usdcAsset,
      "5",
      destinationAccount,
    );

    expect(paths).toHaveLength(0);
  });

  it("returns multiple valid paths when Horizon returns several", async () => {
    const server = mockServer({
      strictReceivePaths: jest.fn().mockReturnValue({
        call: jest.fn().mockResolvedValue({
          records: [
            makePathRecord({ source_amount: "490.0000000" }),
            makePathRecord({ source_amount: "495.0000000" }),
          ],
        }),
      }),
    });
    mockGetStellarServer.mockReturnValue(server);

    const paths = await findPaymentPaths(
      xafAsset,
      usdcAsset,
      "5",
      destinationAccount,
    );

    expect(paths).toHaveLength(2);
  });

  it("handles native XLM as the destination asset", async () => {
    const nativeRecord = {
      destination_asset_type:   "native",
      destination_asset_code:   undefined,
      destination_asset_issuer: undefined,
      source_asset_code:        "XAF",
      source_amount:            "10.0000000",
      path:                     [],
    };

    const server = mockServer({
      strictReceivePaths: jest.fn().mockReturnValue({
        call: jest.fn().mockResolvedValue({ records: [nativeRecord] }),
      }),
    });
    mockGetStellarServer.mockReturnValue(server);

    const paths = await findPaymentPaths(
      xafAsset,
      StellarSdk.Asset.native(),
      "10",
      destinationAccount,
    );

    expect(paths).toHaveLength(1);
  });
});

// ── executePathPayment ────────────────────────────────────────────────────────

describe("executePathPayment", () => {
  beforeEach(() => {
    // Reset AssetService mock to return hasTrustline: true by default
    mockAssetService.mockImplementation(() => ({
      hasTrustline: jest.fn().mockResolvedValue(true),
    }));
  });

  it("submits a PathPaymentStrictReceive and returns hash and ledger", async () => {
    const server = mockServer();
    mockGetStellarServer.mockReturnValue(server);

    const result = await executePathPayment(makeParams());

    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
    expect(result.hash).toBe("txhash123");
    expect(result.ledger).toBe(55);
  });

  it("throws an error when the destination has no trustline for destAsset", async () => {
    mockAssetService.mockImplementation(() => ({
      hasTrustline: jest.fn().mockResolvedValue(false),
    }));

    const server = mockServer();
    mockGetStellarServer.mockReturnValue(server);

    await expect(executePathPayment(makeParams())).rejects.toThrow(
      "Destination has no trustline",
    );
    expect(server.submitTransaction).not.toHaveBeenCalled();
  });

  it("skips the trustline check when destAsset is native XLM", async () => {
    const hasTrustlineMock = jest.fn();
    mockAssetService.mockImplementation(() => ({
      hasTrustline: hasTrustlineMock,
    }));

    const server = mockServer();
    mockGetStellarServer.mockReturnValue(server);

    await executePathPayment(
      makeParams({ destAsset: StellarSdk.Asset.native(), destAmount: "10" }),
    );

    expect(hasTrustlineMock).not.toHaveBeenCalled();
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("passes an explicit path to the operation when provided", async () => {
    const server = mockServer();
    mockGetStellarServer.mockReturnValue(server);

    const intermediateAsset = new StellarSdk.Asset("XLM", undefined);

    await executePathPayment(
      makeParams({ path: [intermediateAsset] }),
    );

    // Transaction was built and submitted — path is encoded inside the tx XDR
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("throws SlippageError when Horizon returns op_over_sendmax", async () => {
    const slippageError = {
      response: {
        data: {
          extras: {
            result_codes: {
              operations: ["op_over_sendmax"],
            },
          },
        },
      },
    };

    const server = mockServer({
      submitTransaction: jest.fn().mockRejectedValue(slippageError),
    });
    mockGetStellarServer.mockReturnValue(server);

    await expect(executePathPayment(makeParams())).rejects.toThrow(SlippageError);
    await expect(executePathPayment(makeParams())).rejects.toThrow(
      "Path payment rejected",
    );
  });

  it("SlippageError message includes the sendMax amount and asset code", async () => {
    const slippageError = {
      response: {
        data: {
          extras: { result_codes: { operations: ["op_over_sendmax"] } },
        },
      },
    };

    const server = mockServer({
      submitTransaction: jest.fn().mockRejectedValue(slippageError),
    });
    mockGetStellarServer.mockReturnValue(server);

    await expect(
      executePathPayment(makeParams({ sendMax: "600", sendAsset: xafAsset })),
    ).rejects.toThrow("600");
  });

  it("re-throws non-slippage errors without wrapping them", async () => {
    const genericError = new Error("Horizon 500 Internal Server Error");

    const server = mockServer({
      submitTransaction: jest.fn().mockRejectedValue(genericError),
    });
    mockGetStellarServer.mockReturnValue(server);

    await expect(executePathPayment(makeParams())).rejects.toThrow(
      "Horizon 500 Internal Server Error",
    );
    await expect(executePathPayment(makeParams())).rejects.not.toThrow(
      SlippageError,
    );
  });

  it("does not throw SlippageError for other Horizon operation errors", async () => {
    const otherOpError = {
      response: {
        data: {
          extras: {
            result_codes: { operations: ["op_no_destination"] },
          },
        },
      },
    };

    const server = mockServer({
      submitTransaction: jest.fn().mockRejectedValue(otherOpError),
    });
    mockGetStellarServer.mockReturnValue(server);

    // Should re-throw the original error, not a SlippageError
    await expect(executePathPayment(makeParams())).rejects.not.toBeInstanceOf(
      SlippageError,
    );
  });
});

// ── SlippageError ─────────────────────────────────────────────────────────────

describe("SlippageError", () => {
  it("has the correct name for instanceof checks", () => {
    const err = new SlippageError("test");
    expect(err.name).toBe("SlippageError");
    expect(err).toBeInstanceOf(SlippageError);
    expect(err).toBeInstanceOf(Error);
  });

  it("preserves the message", () => {
    const err = new SlippageError("sendMax exceeded");
    expect(err.message).toBe("sendMax exceeded");
  });
});