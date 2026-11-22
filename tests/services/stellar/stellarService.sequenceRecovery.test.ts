import * as StellarSdk from "@stellar/stellar-sdk";
import {
  StellarService,
  SequenceLockManager,
  isBadSequenceError,
} from "../../../src/services/stellar/stellarService";

const testIssuerKeypair = StellarSdk.Keypair.random();
const testDestination = StellarSdk.Keypair.random().publicKey();

jest.mock("../../../src/config/stellar", () => ({
  getStellarServer: () => ({
    loadAccount: jest.fn(),
    feeStats: jest.fn(async () => ({ fee_charged: { p90: "100" } })),
    submitTransaction: jest.fn(),
  }),
  getNetworkPassphrase: () => "Test SDF Network ; September 2015",
}));

jest.mock("../../../src/services/sanctionService", () => ({
  sanctionService: {
    checkParties: jest.fn(),
    checkPartiesByAddress: jest.fn(),
  },
}));

jest.mock("../../../src/services/stellar/assetService", () => ({
  AssetService: jest.fn().mockImplementation(() => ({
    hasTrustline: jest.fn().mockResolvedValue(true),
  })),
  getConfiguredPaymentAsset: () => StellarSdk.Asset.native(),
}));

describe("StellarService - Sequence Number Gap Recovery (Issue #2269)", () => {
  let service: StellarService;
  let mockServer: any;
  const env = process.env.STELLAR_ISSUER_SECRET;

  beforeEach(() => {
    process.env.STELLAR_ISSUER_SECRET = testIssuerKeypair.secret();
    service = new StellarService();
    mockServer = (service as any).server;
  });

  afterAll(() => {
    process.env.STELLAR_ISSUER_SECRET = env;
  });

  describe("isBadSequenceError detector", () => {
    it("should detect Horizon 400 bad sequence response with extras.result_codes.transaction = tx_bad_seq", () => {
      const error = {
        response: {
          status: 400,
          data: {
            title: "Transaction Failed",
            detail: "tx_bad_seq",
            extras: {
              result_codes: {
                transaction: "tx_bad_seq",
              },
            },
          },
        },
      };
      expect(isBadSequenceError(error)).toBe(true);
    });

    it("should detect bad sequence in error message string", () => {
      expect(isBadSequenceError(new Error("Transaction failed with tx_bad_seq"))).toBe(true);
      expect(isBadSequenceError(new Error("bad sequence number for account"))).toBe(true);
      expect(isBadSequenceError(new Error("sequence number out of sync"))).toBe(true);
    });

    it("should not detect non-sequence errors", () => {
      const insError = {
        response: {
          status: 400,
          data: {
            extras: {
              result_codes: {
                transaction: "tx_insufficient_balance",
              },
            },
          },
        },
      };
      expect(isBadSequenceError(insError)).toBe(false);
      expect(isBadSequenceError(new Error("Network timeout"))).toBe(false);
      expect(isBadSequenceError(null)).toBe(false);
    });
  });

  describe("SequenceLockManager serialization", () => {
    it("should serialize concurrent submissions on the same account", async () => {
      const lockManager = new SequenceLockManager();
      const accountId = testIssuerKeypair.publicKey();
      const executionOrder: number[] = [];

      const task1 = lockManager.withLock(accountId, async () => {
        await new Promise((r) => setTimeout(r, 40));
        executionOrder.push(1);
      });

      const task2 = lockManager.withLock(accountId, async () => {
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push(2);
      });

      const task3 = lockManager.withLock(accountId, async () => {
        executionOrder.push(3);
      });

      await Promise.all([task1, task2, task3]);
      expect(executionOrder).toEqual([1, 2, 3]);
    });

    it("should maintain and track sequence state per account", () => {
      const lockManager = new SequenceLockManager();
      const accountId = "GACC123";

      expect(lockManager.getTrackedSequence(accountId)).toBeUndefined();
      lockManager.setTrackedSequence(accountId, "500");
      expect(lockManager.getTrackedSequence(accountId)).toBe("500");

      lockManager.clearTrackedSequence(accountId);
      expect(lockManager.getTrackedSequence(accountId)).toBeUndefined();
    });
  });

  describe("Automated Sequence Recovery & Resubmission on Horizon 400", () => {
    it("should catch Horizon 400 tx_bad_seq, refresh sequence from Horizon, and resubmit successfully", async () => {
      const sourceAccountKey = testIssuerKeypair.publicKey();
      let loadCount = 0;
      let submitCount = 0;

      // First load returns sequence 100, second load returns sequence 105 (reflecting gap/advance)
      mockServer.loadAccount.mockImplementation(async (id: string) => {
        loadCount++;
        const seq = loadCount === 1 ? "100" : "105";
        return new StellarSdk.Account(id, seq);
      });

      // First submission fails with tx_bad_seq (400), second submission succeeds
      mockServer.submitTransaction.mockImplementation(async (tx: StellarSdk.Transaction) => {
        submitCount++;
        if (submitCount === 1) {
          const badSeqError: any = new Error("Horizon 400: tx_bad_seq");
          badSeqError.response = {
            status: 400,
            data: {
              title: "Transaction Failed",
              extras: { result_codes: { transaction: "tx_bad_seq" } },
            },
          };
          throw badSeqError;
        }

        return {
          hash: "recovered_tx_hash_12345",
          ledger: 9999,
          successful: true,
        };
      });

      const response = await service.submitWithSequenceRecovery(
        sourceAccountKey,
        async (account) => {
          return new StellarSdk.TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: "Test SDF Network ; September 2015",
          })
            .addOperation(
              StellarSdk.Operation.payment({
                destination: testDestination,
                asset: StellarSdk.Asset.native(),
                amount: "5",
              }),
            )
            .setTimeout(30)
            .build();
        },
        { retryDelayMs: 10 },
      );

      expect(response.hash).toBe("recovered_tx_hash_12345");
      expect(submitCount).toBe(2);
      expect(loadCount).toBe(2);
    });

    it("should verify no transactions are skipped or duplicated during sequence recovery across concurrent calls", async () => {
      const sourceAccountKey = testIssuerKeypair.publicKey();
      let currentHorizonSequence = 1000n;
      const submittedSequenceNumbers: string[] = [];

      mockServer.loadAccount.mockImplementation(async (id: string) => {
        return new StellarSdk.Account(id, currentHorizonSequence.toString());
      });

      mockServer.submitTransaction.mockImplementation(async (tx: StellarSdk.Transaction) => {
        // If transaction sequence does not equal currentHorizonSequence + 1, fail with tx_bad_seq
        if (BigInt(tx.sequence) !== currentHorizonSequence + 1n) {
          const err: any = new Error("tx_bad_seq");
          err.response = {
            status: 400,
            data: { extras: { result_codes: { transaction: "tx_bad_seq" } } },
          };
          throw err;
        }

        currentHorizonSequence = currentHorizonSequence + 1n;
        submittedSequenceNumbers.push(tx.sequence);
        return {
          hash: `tx_hash_${tx.sequence}`,
          ledger: 100,
        };
      });

      // Submit 5 concurrent payments
      const promises = [1, 2, 3, 4, 5].map((i) =>
        service.sendPayment(testDestination, `${i}`),
      );

      const results = await Promise.all(promises);

      // Verify all 5 transactions succeeded
      expect(results).toHaveLength(5);
      for (const res of results) {
        expect(res.hash).toBeDefined();
      }

      // Verify sequential execution without duplicates or skipped sequence numbers
      expect(submittedSequenceNumbers).toEqual(["1001", "1002", "1003", "1004", "1005"]);
      const uniqueSeqs = new Set(submittedSequenceNumbers);
      expect(uniqueSeqs.size).toBe(5);
    });

    it("should throw if max retries are exceeded on persistent tx_bad_seq", async () => {
      mockServer.loadAccount.mockImplementation(async (id: string) => {
        return new StellarSdk.Account(id, "50");
      });

      mockServer.submitTransaction.mockImplementation(async () => {
        const err: any = new Error("tx_bad_seq persistent");
        err.response = {
          status: 400,
          data: { extras: { result_codes: { transaction: "tx_bad_seq" } } },
        };
        throw err;
      });

      await expect(
        service.submitWithSequenceRecovery(
          testIssuerKeypair.publicKey(),
          async (account) =>
            new StellarSdk.TransactionBuilder(account, {
              fee: "100",
              networkPassphrase: "Test SDF Network ; September 2015",
            })
              .addOperation(
                StellarSdk.Operation.payment({
                  destination: testDestination,
                  asset: StellarSdk.Asset.native(),
                  amount: "1",
                }),
              )
              .setTimeout(30)
              .build(),
          { maxRetries: 2, retryDelayMs: 5 },
        ),
      ).rejects.toThrow("tx_bad_seq");
    });
  });
});
