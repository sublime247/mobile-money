import * as StellarSdk from "@stellar/stellar-sdk";
import {
  ESCALATION_THRESHOLD_MS,
  getEscalationMultiplier,
  isPastEscalationThreshold,
  planFeeBumpEscalation,
} from "../feeBumpEscalator";
import { runFeeBumpWatchdogOnce } from "../feeBumpWatchdog";
import { PendingFeeBumpOptions } from "../transactions";

jest.mock("../../config/stellar", () => ({
  getStellarServer: jest.fn(),
  getNetworkPassphrase: jest.fn(() => StellarSdk.Networks.TESTNET),
  getFeeBumpConfig: jest.fn(() => ({
    feePayerPublicKey: "",
    feePayerPrivateKey: "",
    maxFeePerTransaction: 100_000,
    baseFeeStroops: 100,
    maxOperationsPerTransaction: 100,
  })),
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

const NOW = Date.parse("2026-01-01T00:10:00.000Z");
const sourceKeypair = StellarSdk.Keypair.random();
const sponsorKeypair = StellarSdk.Keypair.random();

function makeInnerEnvelope(fee = "100"): string {
  const transaction = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account(sourceKeypair.publicKey(), "123"),
    {
      fee,
      networkPassphrase: StellarSdk.Networks.TESTNET,
      timebounds: { minTime: "0", maxTime: "0" },
    },
  )
    .addOperation(
      StellarSdk.Operation.payment({
        destination: StellarSdk.Keypair.random().publicKey(),
        asset: StellarSdk.Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(30)
    .build();
  transaction.sign(sourceKeypair);
  return transaction.toEnvelope().toXDR("base64");
}

describe("fee bump escalation threshold", () => {
  it("treats a transaction as stuck after three ledger closes (~15s)", () => {
    expect(ESCALATION_THRESHOLD_MS).toBe(15_000);
    expect(isPastEscalationThreshold(NOW - 14_999, NOW)).toBe(false);
    expect(isPastEscalationThreshold(NOW - 15_000, NOW)).toBe(true);
  });

  it("does not bump when timestamps are malformed", () => {
    expect(isPastEscalationThreshold(Number.NaN, NOW)).toBe(false);
    expect(isPastEscalationThreshold(NOW - 60_000, Number.NaN)).toBe(false);
  });
});

describe("fee bump escalation multiplier", () => {
  it("escalates each attempt more aggressively than the last", () => {
    expect(getEscalationMultiplier(1)).toBeCloseTo(1.5);
    expect(getEscalationMultiplier(2)).toBeCloseTo(2.25);
    expect(getEscalationMultiplier(3)).toBeCloseTo(3.375);
  });

  it("rejects invalid attempts and steps", () => {
    expect(() => getEscalationMultiplier(0)).toThrow("positive integer");
    expect(() => getEscalationMultiplier(1.5)).toThrow("positive integer");
    expect(() => getEscalationMultiplier(1, 1)).toThrow("greater than 1");
  });
});

describe("planFeeBumpEscalation", () => {
  it("plans the first bump with the first escalation multiplier", () => {
    const decision = planFeeBumpEscalation({
      originalFee: 1000,
      operationCount: 1,
      bumpCount: 0,
      maxFee: 100_000,
    });

    expect(decision.shouldBump).toBe(true);
    expect(decision.multiplier).toBeCloseTo(1.5);
    expect(decision.maxFee).toBe(100_000);
  });

  it("stops once the current fee already sits at the ceiling", () => {
    const decision = planFeeBumpEscalation({
      originalFee: 1000,
      operationCount: 1,
      bumpCount: 2,
      currentFee: 1050,
      maxFee: 1050,
    });

    expect(decision).toEqual({
      shouldBump: false,
      reason: "maximum fee ceiling already reached",
    });
  });

  it("skips instead of throwing when the ceiling cannot cover the minimum", () => {
    const decision = planFeeBumpEscalation({
      originalFee: 1000,
      operationCount: 1,
      bumpCount: 0,
      maxFee: 1050,
    });

    expect(decision.shouldBump).toBe(false);
    expect(decision.reason).toContain("exceeds max allowed 1050");
  });

  it("skips when no ceiling is configured", () => {
    const decision = planFeeBumpEscalation({
      originalFee: 1000,
      operationCount: 1,
      bumpCount: 0,
      maxFee: 0,
    });

    expect(decision).toEqual({
      shouldBump: false,
      reason: "fee ceiling is not configured",
    });
  });
});

describe("runFeeBumpWatchdogOnce escalation", () => {
  it("leaves a transaction alone while it is still inside the mempool window", async () => {
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
      ],
      getLedgerClosedAt: async () => NOW,
      isConfirmed: async () => false,
      submit,
    });

    expect(result.skipped).toBe(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("escalates the multiplier per prior fee bump", async () => {
    const multipliers: Array<number | undefined> = [];
    const bumpFee = jest.fn(
      (envelope: string, options: PendingFeeBumpOptions) => {
        multipliers.push(options.multiplier);
        return {
          envelope,
          originalFee: 100,
          fee: 200,
          baseFee: 100,
          innerTransactionHash: "inner",
          feeBumpTransactionHash: "bump",
          feePayer: sponsorKeypair.publicKey(),
        };
      },
    );

    await runFeeBumpWatchdogOnce({
      now: () => NOW,
      loadPending: async () => [
        {
          id: "stuck",
          hash: "stuck-hash",
          envelope: makeInnerEnvelope(),
          submittedAt: new Date(NOW - 60_000).toISOString(),
          feeBumps: [{ fee: 200 }],
        },
      ],
      getLedgerClosedAt: async () => NOW,
      isConfirmed: async () => false,
      bumpFee,
      submit: async () => ({ success: true, transactionHash: "new" }),
      onBumped: async () => undefined,
    });

    expect(multipliers).toEqual([expect.closeTo(2.25)]);
  });

  it("skips a transaction whose last fee bump already hit the ceiling", async () => {
    const bumpFee = jest.fn();
    const submit = jest.fn();
    const result = await runFeeBumpWatchdogOnce({
      now: () => NOW,
      maxFee: 5_000,
      loadPending: async () => [
        {
          id: "capped",
          hash: "capped-hash",
          envelope: makeInnerEnvelope(),
          submittedAt: new Date(NOW - 60_000).toISOString(),
          feeBumps: [{ fee: 5_000 }],
        },
      ],
      getLedgerClosedAt: async () => NOW,
      isConfirmed: async () => false,
      bumpFee,
      submit,
    });

    expect(result.skipped).toBe(1);
    expect(bumpFee).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
