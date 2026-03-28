import * as StellarSdk from "stellar-sdk";
import {
  buildTransactionWithFeeBump,
  calculateMaxFee,
  estimateFee,
  getFeePayerSequence,
  submitTransaction,
} from "../transactions";

jest.mock("../../config/stellar", () => ({
  getStellarServer: jest.fn(),
  getNetworkPassphrase: jest.fn(() => StellarSdk.Networks.TESTNET),
  getFeeBumpConfig: jest.fn(),
}));

import {
  getFeeBumpConfig,
  getStellarServer,
} from "../../config/stellar";

const mockGetStellarServer = getStellarServer as jest.Mock;
const mockGetFeeBumpConfig = getFeeBumpConfig as jest.Mock;

const sourceKeypair = StellarSdk.Keypair.random();
const feePayerKeypair = StellarSdk.Keypair.random();
const destination = StellarSdk.Keypair.random().publicKey();

function makeAccount(accountId: string, sequence = "123") {
  return new StellarSdk.Account(accountId, sequence);
}

function makeServer(overrides: Record<string, unknown> = {}) {
  return {
    fetchBaseFee: jest.fn().mockResolvedValue(100),
    fetchTimebounds: jest.fn().mockResolvedValue({
      minTime: "0",
      maxTime: "1700000000",
    }),
    loadAccount: jest.fn(async (accountId: string) => {
      if (accountId === feePayerKeypair.publicKey()) {
        return makeAccount(accountId, "999");
      }

      return makeAccount(accountId, "123");
    }),
    submitTransaction: jest.fn().mockResolvedValue({
      hash: "submitted-hash",
      fee_charged: 200,
      result_xdr: "result-xdr",
    }),
    ...overrides,
  };
}

function makePaymentOperation() {
  return StellarSdk.Operation.payment({
    destination,
    asset: StellarSdk.Asset.native(),
    amount: "1",
  }) as any;
}

describe("stellar fee bump transactions", () => {
  beforeEach(() => {
    mockGetFeeBumpConfig.mockReturnValue({
      feePayerPublicKey: feePayerKeypair.publicKey(),
      feePayerPrivateKey: feePayerKeypair.secret(),
      maxFeePerTransaction: 10_000,
      baseFeeStroops: 100,
      maxOperationsPerTransaction: 100,
    });
  });

  it("wraps the inner transaction in a fee bump and signs it with the fee payer", async () => {
    const server = makeServer();
    mockGetStellarServer.mockReturnValue(server);

    const result = await buildTransactionWithFeeBump({
      sourceAccount: sourceKeypair.publicKey(),
      operations: [makePaymentOperation()],
    });

    const parsed = StellarSdk.TransactionBuilder.fromXDR(
      result.envelope,
      StellarSdk.Networks.TESTNET,
    );

    expect(result.usedFeeBump).toBe(true);
    expect(parsed).toBeInstanceOf(StellarSdk.FeeBumpTransaction);
    if (!(parsed instanceof StellarSdk.FeeBumpTransaction)) {
      throw new Error("Expected fee bump transaction");
    }
    expect(parsed.feeSource).toBe(feePayerKeypair.publicKey());
    expect(Number(parsed.fee)).toBe(200);
    expect(parsed.innerTransaction.source).toBe(sourceKeypair.publicKey());
    expect(parsed.innerTransaction.signatures).toHaveLength(0);
    expect(parsed.signatures).toHaveLength(1);
    expect(server.loadAccount).toHaveBeenCalledWith(sourceKeypair.publicKey());
    expect(server.loadAccount).toHaveBeenCalledWith(feePayerKeypair.publicKey());
    expect(getFeePayerSequence()).toBe(999);
  });

  it("returns a plain inner transaction when fee bumping is disabled", async () => {
    const server = makeServer();
    mockGetStellarServer.mockReturnValue(server);

    const result = await buildTransactionWithFeeBump({
      sourceAccount: sourceKeypair.publicKey(),
      operations: [makePaymentOperation()],
      enableFeeBump: false,
    });

    const parsed = StellarSdk.TransactionBuilder.fromXDR(
      result.envelope,
      StellarSdk.Networks.TESTNET,
    );

    expect(result.usedFeeBump).toBe(false);
    expect(parsed).toBeInstanceOf(StellarSdk.Transaction);
    expect(parsed.fee).toBe("100");
  });

  it("enforces the configured fee cap for fee-bumped transactions", async () => {
    const server = makeServer({
      fetchBaseFee: jest.fn().mockResolvedValue(300),
    });
    mockGetStellarServer.mockReturnValue(server);
    mockGetFeeBumpConfig.mockReturnValue({
      feePayerPublicKey: feePayerKeypair.publicKey(),
      feePayerPrivateKey: feePayerKeypair.secret(),
      maxFeePerTransaction: 500,
      baseFeeStroops: 100,
      maxOperationsPerTransaction: 100,
    });

    await expect(
      buildTransactionWithFeeBump({
        sourceAccount: sourceKeypair.publicKey(),
        operations: [makePaymentOperation()],
      }),
    ).rejects.toThrow("exceeds max allowed 500");
  });

  it("submits fee bump envelopes as parsed transactions and refreshes fee payer state", async () => {
    const server = makeServer();
    mockGetStellarServer.mockReturnValue(server);

    const built = await buildTransactionWithFeeBump({
      sourceAccount: sourceKeypair.publicKey(),
      operations: [makePaymentOperation()],
    });

    const result = await submitTransaction(built.envelope);

    expect(result).toEqual({
      success: true,
      transactionHash: "submitted-hash",
      envelope: built.envelope,
      feeCharged: 200,
      resultXdr: "result-xdr",
    });
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
    const submittedTx = server.submitTransaction.mock.calls[0][0];
    expect(submittedTx).toBeInstanceOf(StellarSdk.FeeBumpTransaction);
    expect(server.loadAccount).toHaveBeenCalledWith(feePayerKeypair.publicKey());
  });

  it("rejects submission when the envelope fee exceeds the configured maximum", async () => {
    const server = makeServer();
    mockGetStellarServer.mockReturnValue(server);

    const overLimitEnvelope = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
      feePayerKeypair,
      "10000",
      new StellarSdk.TransactionBuilder(makeAccount(sourceKeypair.publicKey(), "123"), {
        fee: "100",
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(makePaymentOperation())
        .setTimeout(30)
        .build(),
      StellarSdk.Networks.TESTNET,
    )
      .toEnvelope()
      .toXDR("base64");

    const result = await submitTransaction(overLimitEnvelope);

    expect(result.success).toBe(false);
    expect(result.error).toContain("exceeds max allowed");
    expect(server.submitTransaction).not.toHaveBeenCalled();
  });

  it("estimates and calculates fee-bump fees using the outer charged op count", () => {
    const estimate = estimateFee(2);

    expect(estimate).toEqual({
      baseFee: 100,
      operationCount: 2,
      estimatedFee: 300,
      maxFee: 10_000,
      exceedsMax: false,
    });
    expect(calculateMaxFee(2, 100, 10_000)).toBe(300);
    expect(() => calculateMaxFee(2, 5000, 10_000)).toThrow(
      "exceeds max allowed 10000",
    );
  });
});
