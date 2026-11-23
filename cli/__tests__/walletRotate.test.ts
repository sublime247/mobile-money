/**
 * cli/__tests__/walletRotate.test.ts (#2361)
 *
 * Uses node:test + node:assert, matching this CLI package's existing test
 * convention (see src/utils/cliFormatting.test.ts, src/setupWizard.test.ts)
 * rather than Jest, which this package does not depend on.
 *
 * Exercises the pure orchestration logic (runPreflightChecks, transferFloat)
 * against a hand-built fake Horizon server object, so these run with no
 * network access and no real Stellar SDK dependency behavior beyond the
 * plain data shapes Horizon responses use.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  runPreflightChecks,
  transferFloat,
  type PreflightReport,
  type RotationAsset,
} from "../src/commands/walletRotate";

const TEST_KEYPAIR = StellarSdk.Keypair.random();

const OLD_PUBLIC_KEY = StellarSdk.Keypair.random().publicKey();
const NEW_PUBLIC_KEY = StellarSdk.Keypair.random().publicKey();
const USDC_ISSUER = StellarSdk.Keypair.random().publicKey();

type FakeAccountBalances = Array<
  | { asset_type: "native"; balance: string }
  | {
      asset_type: string;
      asset_code: string;
      asset_issuer: string;
      balance: string;
    }
>;

function buildFakeServer(
  accounts: Record<
    string,
    { sequenceNumber: () => string; balances: FakeAccountBalances }
  >,
) {
  return {
    loadAccount: async (publicKey: string) => {
      const account = accounts[publicKey];
      if (!account) throw new Error("not found");
      // TransactionBuilder requires a full Account-like interface
      // (accountId/incrementSequenceNumber/etc) when the loaded account is
      // used as the transaction source; preflight-only lookups just read
      // .sequenceNumber()/.balances, which this also provides.
      return Object.assign(
        new StellarSdk.Account(publicKey, account.sequenceNumber()),
        { balances: account.balances },
      ) as unknown;
    },
    submitTransaction: async () => ({ hash: "fake-tx-hash" }),
  } as any;
}

test("runPreflightChecks reports a funded new wallet with a required trustline as ready to rotate", async () => {
  const server = buildFakeServer({
    [NEW_PUBLIC_KEY]: {
      sequenceNumber: () => "100",
      balances: [
        { asset_type: "native", balance: "50" },
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: USDC_ISSUER,
          balance: "0",
        },
      ],
    },
    [OLD_PUBLIC_KEY]: {
      sequenceNumber: () => "10",
      balances: [
        { asset_type: "native", balance: "500" },
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: USDC_ISSUER,
          balance: "1000",
        },
      ],
    },
  });

  const assets: RotationAsset[] = [
    { code: "XLM" },
    { code: "USDC", issuer: USDC_ISSUER },
  ];

  const report = await runPreflightChecks(
    server,
    { newPublicKey: NEW_PUBLIC_KEY, assets },
    OLD_PUBLIC_KEY,
  );

  assert.equal(report.newWalletFunded, true);
  assert.equal(report.newWalletSequence, "100");
  assert.equal(report.readyToRotate, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.oldWalletBalances.XLM, "500");
  assert.equal(report.oldWalletBalances[`USDC:${USDC_ISSUER}`], "1000");
});

test("runPreflightChecks blocks rotation when the new wallet is unfunded", async () => {
  const server = buildFakeServer({
    [OLD_PUBLIC_KEY]: {
      sequenceNumber: () => "10",
      balances: [{ asset_type: "native", balance: "500" }],
    },
  });

  const report = await runPreflightChecks(
    server,
    { newPublicKey: NEW_PUBLIC_KEY, assets: [{ code: "XLM" }] },
    OLD_PUBLIC_KEY,
  );

  assert.equal(report.newWalletFunded, false);
  assert.equal(report.readyToRotate, false);
  assert.ok(report.blockers.some((b) => b.includes("not funded")));
});

test("runPreflightChecks blocks rotation when the new wallet is missing a required trustline", async () => {
  const server = buildFakeServer({
    [NEW_PUBLIC_KEY]: {
      sequenceNumber: () => "1",
      balances: [{ asset_type: "native", balance: "5" }], // no USDC trustline
    },
    [OLD_PUBLIC_KEY]: {
      sequenceNumber: () => "10",
      balances: [
        { asset_type: "native", balance: "500" },
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: USDC_ISSUER,
          balance: "1000",
        },
      ],
    },
  });

  const report = await runPreflightChecks(
    server,
    {
      newPublicKey: NEW_PUBLIC_KEY,
      assets: [{ code: "XLM" }, { code: "USDC", issuer: USDC_ISSUER }],
    },
    OLD_PUBLIC_KEY,
  );

  assert.equal(report.readyToRotate, false);
  assert.ok(
    report.blockers.some((b) => b.includes("missing a trustline for USDC")),
  );
  const usdcCheck = report.trustlineChecks.find((c) => c.asset.code === "USDC");
  assert.equal(usdcCheck?.hasTrustline, false);
});

test("transferFloat in --dry-run mode reports transfers without submitting a transaction", async () => {
  const server = buildFakeServer({});
  const preflight: PreflightReport = {
    newWalletFunded: true,
    newWalletSequence: "100",
    trustlineChecks: [{ asset: { code: "XLM" }, hasTrustline: true }],
    oldWalletBalances: { XLM: "500" },
    readyToRotate: true,
    blockers: [],
  };

  const transfers = await transferFloat(
    server,
    // transferFloat only reads .publicKey() off the "keypair" in dry-run
    // mode via the account loader, which is never reached when dryRun is
    // true - a minimal stub keeps this test independent of real keys.
    { publicKey: () => OLD_PUBLIC_KEY } as any,
    {
      newPublicKey: NEW_PUBLIC_KEY,
      networkPassphrase: "Test SDF Network ; September 2015",
      dryRun: true,
    },
    preflight,
  );

  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].skipped, true);
  assert.equal(transfers[0].amount, "500");
  assert.ok(transfers[0].skipReason?.includes("dry-run"));
});

test("transferFloat (live mode) skips an asset with a zero balance on the old wallet", async () => {
  const oldPublicKey = TEST_KEYPAIR.publicKey();
  const server = buildFakeServer({
    [oldPublicKey]: {
      sequenceNumber: () => "10",
      balances: [{ asset_type: "native", balance: "500" }],
    },
  });
  const preflight: PreflightReport = {
    newWalletFunded: true,
    newWalletSequence: "100",
    trustlineChecks: [
      { asset: { code: "XLM" }, hasTrustline: true },
      { asset: { code: "USDC", issuer: USDC_ISSUER }, hasTrustline: true },
    ],
    oldWalletBalances: { XLM: "500" }, // no USDC entry -> treated as zero
    readyToRotate: true,
    blockers: [],
  };

  const transfers = await transferFloat(
    server,
    TEST_KEYPAIR,
    {
      newPublicKey: NEW_PUBLIC_KEY,
      networkPassphrase: StellarSdk.Networks.TESTNET,
      dryRun: false,
    },
    preflight,
  );

  const usdcTransfer = transfers.find((t) => t.asset.code === "USDC");
  assert.equal(usdcTransfer?.skipped, true);
  assert.ok(usdcTransfer?.skipReason?.includes("zero balance"));

  const xlmTransfer = transfers.find((t) => t.asset.code === "XLM");
  assert.equal(xlmTransfer?.skipped, undefined);
  assert.equal(xlmTransfer?.txHash, "fake-tx-hash");
});
