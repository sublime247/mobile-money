import * as StellarSdk from "@stellar/stellar-sdk";
import {
  calculatePendingFeeBumpBaseFee,
  createFeeBumpForPendingTransaction,
} from "../transactions";
import { runFeeBumpWatchdogOnce } from "../feeBumpWatchdog";

jest.mock("../../config/stellar", () => ({
  getStellarServer: jest.fn(),
  getNetworkPassphrase: jest.fn(() => StellarSdk.Networks.TESTNET),
  getFeeBumpConfig: jest.fn(),
}));

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));

jest.mock("../../models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    updateMetadata: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { getFeeBumpConfig } from "../../config/stellar";

const MAX_FEE = 100_000;
const NOW = Date.parse("2026-01-01T00:10:00.000Z");
const SUBMITTED_AT = new Date(NOW - 90_000).toISOString();

const sourceKeypair = StellarSdk.Keypair.random();
const sponsorKeypair = StellarSdk.Keypair.random();
const destination = StellarSdk.Keypair.random().publicKey();

function makePaymentOperation() {
  return StellarSdk.Operation.payment({
    destination,
    asset: StellarSdk.Asset.native(),
    amount: "1",
  });
}

function makeInnerEnvelope(fee = "100"): string {
  const transaction = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account(sourceKeypair.publicKey(), "123"),
    {
      fee,
      networkPassphrase: StellarSdk.Networks.TESTNET,
      timebounds: { minTime: "0", maxTime: "0" },
    },
  )
    .addOperation(makePaymentOperation())
    .setTimeout(30)
    .build();
  transaction.sign(sourceKeypair);
  return transaction.toEnvelope().toXDR("base64");
}

function parseFeeBump(envelope: string): StellarSdk.FeeBumpTransaction {
  const parsed = StellarSdk.TransactionBuilder.fromXDR(
    envelope,
    StellarSdk.Networks.TESTNET,
  );
  if (!(parsed instanceof StellarSdk.FeeBumpTransaction)) {
    throw new Error("Expected a fee bump transaction");
  }
  return parsed;
}

beforeEach(() => {
  (getFeeBumpConfig as jest.Mock).mockReturnValue({
    feePayerPublicKey: sponsorKeypair.publicKey(),
    feePayerPrivateKey: sponsorKeypair.secret(),
    maxFeePerTransaction: MAX_FEE,
    baseFeeStroops: 100,
    maxOperationsPerTransaction: 100,
  });
});

describe("pending transaction fee bump generation", () => {
  it("wraps a stale transaction and signs it with the fee sponsor", () => {
    const envelope = makeInnerEnvelope();
    const result = createFeeBumpForPendingTransaction(envelope, {
      feePayerKeypair: sponsorKeypair,
    });

    const feeBump = parseFeeBump(result.envelope);
    expect(feeBump.feeSource).toBe(sponsorKeypair.publicKey());
    expect(feeBump.signatures).toHaveLength(1);
    expect(feeBump.innerTransaction.source).toBe(sourceKeypair.publicKey());
    expect(result.feePayer).toBe(sponsorKeypair.publicKey());
    expect(result.originalFee).toBe(100);
    expect(result.innerTransactionHash).toBe(
      Buffer.from(feeBump.innerTransaction.hash()).toString("hex"),
    );
    expect(result.feeBumpTransactionHash).toBe(
      Buffer.from(feeBump.hash()).toString("hex"),
    );
  });

  it("applies a 1.5x fee where the SDK minimum permits", () => {
    const baseFee = calculatePendingFeeBumpBaseFee(1000, 10);

    expect(baseFee).toBe(137);
    expect(baseFee * 11).toBe(1507);
  });

  it("respects the SDK minimum per-operation fee for the bump", () => {
    const result = createFeeBumpForPendingTransaction(
      makeInnerEnvelope("1000"),
      {
        feePayerKeypair: sponsorKeypair,
      },
    );

    expect(result.originalFee).toBe(1000);
    expect(result.baseFee).toBe(1000);
    expect(result.fee).toBe(2000);
    expect(Number(parseFeeBump(result.envelope).fee)).toBe(2000);
  });

  it("never exceeds the configured maximum fee", () => {
    const baseFee = calculatePendingFeeBumpBaseFee(1000, 10, { maxFee: 1200 });

    expect(baseFee).toBe(109);
    expect(baseFee * 11).toBeLessThanOrEqual(1200);
  });

  it("rejects a fee bump when the cap cannot cover the minimum increment", () => {
    expect(() =>
      calculatePendingFeeBumpBaseFee(1000, 1, { maxFee: 1050 }),
    ).toThrow("exceeds max allowed 1050");
    expect(() =>
      createFeeBumpForPendingTransaction(makeInnerEnvelope("1000"), {
        feePayerKeypair: sponsorKeypair,
        maxFee: 1050,
      }),
    ).toThrow("exceeds max allowed 1050");
  });

  it("rejects an already fee-bumped envelope", () => {
    const bumped = createFeeBumpForPendingTransaction(makeInnerEnvelope(), {
      feePayerKeypair: sponsorKeypair,
    });

    expect(() =>
      createFeeBumpForPendingTransaction(bumped.envelope, {
        feePayerKeypair: sponsorKeypair,
      }),
    ).toThrow("already a fee bump transaction");
  });
});

describe("pending transaction fee bump watchdog", () => {
  it("bumps a transaction held in mempool past one ledger close interval", async () => {
    const envelope = makeInnerEnvelope();
    const submitted: string[] = [];
    const onBumped = jest.fn().mockResolvedValue(undefined);

    const result = await runFeeBumpWatchdogOnce({
      now: () => NOW,
      ledgerCloseTimeMs: 5_000,
      loadPending: async () => [
        {
          id: "tx-1",
          hash: StellarSdk.TransactionBuilder.fromXDR(
            envelope,
            StellarSdk.Networks.TESTNET,
          )
            .hash()
            .toString("hex"),
          envelope,
          submittedAt: SUBMITTED_AT,
        },
      ],
      getLedgerClosedAt: async () => NOW + 1_000,
      isConfirmed: async () => false,
      submit: async (bumpEnvelope) => {
        submitted.push(bumpEnvelope);
        return {
          success: true,
          transactionHash: "new-hash",
          envelope: bumpEnvelope,
        };
      },
      onBumped,
    });

    expect(result).toEqual({
      inspected: 1,
      bumped: 1,
      confirmed: 0,
      skipped: 0,
      failed: 0,
    });
    expect(submitted).toHaveLength(1);
    expect(parseFeeBump(submitted[0]).innerTransaction.source).toBe(
      sourceKeypair.publicKey(),
    );
    expect(onBumped).toHaveBeenCalledTimes(1);
  });

  it("skips fresh transactions, confirmed hashes and exhausted fee bumps", async () => {
    const submit = jest.fn();
    const result = await runFeeBumpWatchdogOnce({
      now: () => NOW,
      loadPending: async () => [
        {
          id: "fresh",
          hash: "fresh-hash",
          envelope: makeInnerEnvelope(),
          submittedAt: new Date(NOW - 10_000).toISOString(),
        },
        {
          id: "confirmed",
          hash: "confirmed-hash",
          envelope: makeInnerEnvelope(),
          submittedAt: SUBMITTED_AT,
        },
        {
          id: "exhausted",
          hash: "exhausted-hash",
          envelope: makeInnerEnvelope(),
          submittedAt: SUBMITTED_AT,
          feeBumps: [1, 2, 3],
        },
      ],
      getLedgerClosedAt: async () => NOW,
      isConfirmed: async (hash) => hash === "confirmed-hash",
      submit,
    });

    expect(result).toEqual({
      inspected: 3,
      bumped: 0,
      confirmed: 1,
      skipped: 2,
      failed: 0,
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
