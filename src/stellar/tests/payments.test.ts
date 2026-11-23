import * as StellarSdk from "@stellar/stellar-sdk";
import {
  buildCreateClaimableBalanceOperation,
  DEFAULT_CLAIMABLE_BALANCE_RECOVERY_SECONDS,
  refundToClaimableBalance,
  routeRefundPayment,
} from "../payments";

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
const mockAssetService = AssetService as jest.Mock;

const sourceKeypair = StellarSdk.Keypair.random();
const destination = StellarSdk.Keypair.random().publicKey();
const anchor = StellarSdk.Keypair.random().publicKey();
const asset = new StellarSdk.Asset(
  "USDC",
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
);

function makeServer() {
  return {
    loadAccount: jest
      .fn()
      .mockImplementation(
        async (accountId: string) => new StellarSdk.Account(accountId, "123"),
      ),
    submitTransaction: jest.fn().mockResolvedValue({
      hash: "claimable-balance-hash",
      ledger: 77,
    }),
  };
}

function decodeClaimableBalance(operation: StellarSdk.xdr.Operation): any {
  const body = operation.body as any;
  expect(body.type).toBe("createClaimableBalance");
  const detail = body.createClaimableBalanceOp;
  return {
    amount: detail.amount,
    claimants: detail.claimants.map((claimant: any) => ({
      destination: StellarSdk.StrKey.encodeEd25519PublicKey(
        claimant.v0.destination.ed25519.value,
      ),
      predicate: claimant.v0.predicate,
    })),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssetService.mockImplementation(() => ({
    hasTrustline: jest.fn().mockResolvedValue(true),
  }));
});

describe("claimable balance refund builder", () => {
  it("creates an unconditional recipient claimant and a time-delayed anchor claimant", () => {
    const operation = buildCreateClaimableBalanceOperation({
      sourceKeypair,
      destination,
      asset,
      amount: "10",
      anchorRecoveryAccount: anchor,
      recoveryDelaySeconds: 600,
    });
    const decoded = decodeClaimableBalance(operation);

    expect(decoded.amount.toString()).toBe("100000000");
    expect(decoded.claimants).toHaveLength(2);
    expect(decoded.claimants[0].destination).toBe(destination);
    expect(decoded.claimants[0].predicate.type).toBe(
      "claimPredicateUnconditional",
    );
    expect(decoded.claimants[1].destination).toBe(anchor);
    expect(decoded.claimants[1].predicate.type).toBe("claimPredicateNot");
    expect(decoded.claimants[1].predicate.notPredicate.type).toBe(
      "claimPredicateBeforeRelativeTime",
    );
    expect(decoded.claimants[1].predicate.notPredicate.relBefore).toBe(
      BigInt(600),
    );
  });

  it("defaults recovery to the source account and a seven day delay", () => {
    const operation = buildCreateClaimableBalanceOperation({
      sourceKeypair,
      destination,
      asset,
      amount: "10",
    });
    const decoded = decodeClaimableBalance(operation);

    expect(decoded.claimants[1].destination).toBe(sourceKeypair.publicKey());
    expect(decoded.claimants[1].predicate.notPredicate.relBefore).toBe(
      BigInt(DEFAULT_CLAIMABLE_BALANCE_RECOVERY_SECONDS),
    );
  });

  it("rejects invalid recovery settings and claimants", () => {
    expect(() =>
      buildCreateClaimableBalanceOperation({
        sourceKeypair,
        destination,
        asset,
        amount: "10",
        recoveryDelaySeconds: 0,
      }),
    ).toThrow("Recovery delay must be positive");
    expect(() =>
      buildCreateClaimableBalanceOperation({
        sourceKeypair,
        destination: "not-an-account",
        asset,
        amount: "10",
      }),
    ).toThrow("Invalid claimable balance destination");
  });

  it("submits a signed claimable balance transaction", async () => {
    const server = makeServer();
    mockGetStellarServer.mockReturnValue(server);

    const result = await refundToClaimableBalance({
      sourceKeypair,
      destination,
      asset,
      amount: "10",
      anchorRecoveryAccount: anchor,
      recoveryDelaySeconds: 600,
    });

    expect(result).toMatchObject({
      hash: "claimable-balance-hash",
      ledger: 77,
      destination,
      recoveryAccount: anchor,
      recoveryDelaySeconds: 600,
    });

    const submitted = server.submitTransaction.mock.calls[0][0];
    expect(submitted.operations).toHaveLength(1);
    expect(submitted.operations[0].type).toBe("createClaimableBalance");
    expect(submitted.signatures).toHaveLength(1);
    expect(() =>
      StellarSdk.TransactionBuilder.fromXDR(
        result.envelope,
        StellarSdk.Networks.TESTNET,
      ),
    ).not.toThrow();
  });
});

describe("refund fallback routing", () => {
  const makeParams = () => ({
    sourceKeypair,
    destination,
    asset,
    amount: "10",
    sendPayment: jest.fn().mockResolvedValue({
      hash: "payment-hash",
      submittedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  });

  it("routes to a claimable balance when the recipient lacks the trustline", async () => {
    const server = makeServer();
    mockGetStellarServer.mockReturnValue(server);
    mockAssetService.mockImplementation(() => ({
      hasTrustline: jest.fn().mockResolvedValue(false),
    }));
    const params = makeParams();

    const result = await routeRefundPayment(params);

    expect(result.method).toBe("claimable_balance");
    expect(result.hash).toBe("claimable-balance-hash");
    expect(params.sendPayment).not.toHaveBeenCalled();
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("uses the normal payment when the recipient holds the trustline", async () => {
    const server = makeServer();
    mockGetStellarServer.mockReturnValue(server);
    const params = makeParams();

    const result = await routeRefundPayment(params);

    expect(result.method).toBe("payment");
    expect(result.hash).toBe("payment-hash");
    expect(params.sendPayment).toHaveBeenCalledTimes(1);
    expect(server.submitTransaction).not.toHaveBeenCalled();
  });

  it("skips the trustline check for native assets", async () => {
    const hasTrustline = jest.fn();
    mockAssetService.mockImplementation(() => ({ hasTrustline }));
    const params = { ...makeParams(), asset: StellarSdk.Asset.native() };

    const result = await routeRefundPayment(params);

    expect(result.method).toBe("payment");
    expect(hasTrustline).not.toHaveBeenCalled();
  });
});
