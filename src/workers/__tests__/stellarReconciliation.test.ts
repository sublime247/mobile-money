import {
  lookupHorizonTransaction,
  StellarReconciliationWorker,
  runStellarReconciliationJob,
} from "../stellarReconciliation";

describe("Stellar Anchor Transaction Reconciliation Worker (#1993)", () => {
  const dummyHash = "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0";

  describe("lookupHorizonTransaction", () => {
    it("should return confirmed=true and ledger details when transaction exists on Horizon", async () => {
      const mockServer = {
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({
            call: jest.fn().mockResolvedValue({
              successful: true,
              ledger_attr: 123456,
              created_at: "2026-09-25T12:00:00Z",
            }),
          }),
        }),
      };

      const result = await lookupHorizonTransaction(mockServer, dummyHash);
      expect(result.confirmed).toBe(true);
      expect(result.successful).toBe(true);
      expect(result.ledger).toBe(123456);
      expect(result.createdAt).toBe("2026-09-25T12:00:00Z");
    });

    it("should return confirmed=false and notFound=true on 404 response", async () => {
      const notFoundError = new Error("Not Found") as any;
      notFoundError.response = { status: 404 };

      const mockServer = {
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({
            call: jest.fn().mockRejectedValue(notFoundError),
          }),
        }),
      };

      const result = await lookupHorizonTransaction(mockServer, dummyHash);
      expect(result.confirmed).toBe(false);
      expect(result.notFound).toBe(true);
    });

    it("should return confirmed=false and error on other server errors", async () => {
      const serverError = new Error("Network timeout") as any;
      serverError.response = { status: 500 };

      const mockServer = {
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({
            call: jest.fn().mockRejectedValue(serverError),
          }),
        }),
      };

      const result = await lookupHorizonTransaction(mockServer, dummyHash);
      expect(result.confirmed).toBe(false);
      expect(result.notFound).toBe(false);
      expect(result.error).toBe("Network timeout");
    });

    it("should handle empty hash without querying Horizon", async () => {
      const mockServer = {
        transactions: jest.fn(),
      };

      const result = await lookupHorizonTransaction(mockServer, "");
      expect(result.confirmed).toBe(false);
      expect(result.notFound).toBe(true);
      expect(mockServer.transactions).not.toHaveBeenCalled();
    });
  });

  describe("StellarReconciliationWorker reconciliation cycle", () => {
    let mockPool: any;
    let mockHorizonServer: any;
    let worker: StellarReconciliationWorker;

    beforeEach(() => {
      mockPool = {
        query: jest.fn(),
      };
      mockHorizonServer = {
        transactions: jest.fn(),
      };
      worker = new StellarReconciliationWorker({
        pool: mockPool,
        horizonServer: mockHorizonServer,
        reviewThresholdHours: 2,
      });
    });

    it("should scan pending transactions and mark confirmed transactions as completed in database", async () => {
      const recentDate = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
      mockPool.query
        .mockResolvedValueOnce({
          // SELECT from transactions
          rows: [
            {
              id: "tx-1",
              reference_number: "REF123",
              status: "pending",
              created_at: recentDate,
              metadata: { stellarTransactionHash: dummyHash },
            },
          ],
        })
        .mockResolvedValueOnce({
          // UPDATE transactions SET status = 'completed'
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          // SELECT from sep24_transactions
          rows: [],
        });

      mockHorizonServer.transactions.mockReturnValue({
        transaction: jest.fn().mockReturnValue({
          call: jest.fn().mockResolvedValue({
            successful: true,
            ledger_attr: 987654,
            created_at: recentDate.toISOString(),
          }),
        }),
      });

      const summary = await worker.reconcile();

      expect(summary.scanned).toBe(1);
      expect(summary.confirmed).toBe(1);
      expect(summary.flagged).toBe(0);

      // Verify update query sets status to completed and updates metadata
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'completed'"),
        ["tx-1"],
      );
    });

    it("should flag unconfirmed transactions older than 2 hours for manual operator review", async () => {
      const staleDate = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago (> 2 hours)
      mockPool.query
        .mockResolvedValueOnce({
          // SELECT from transactions
          rows: [
            {
              id: "tx-stale",
              reference_number: "REF-STALE",
              status: "pending",
              created_at: staleDate,
              metadata: { stellarTransactionHash: dummyHash },
            },
          ],
        })
        .mockResolvedValueOnce({
          // UPDATE transactions SET admin_notes = ... requires_manual_review = true
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          // SELECT from sep24_transactions
          rows: [],
        });

      const notFoundErr = new Error("Not Found") as any;
      notFoundErr.response = { status: 404 };
      mockHorizonServer.transactions.mockReturnValue({
        transaction: jest.fn().mockReturnValue({
          call: jest.fn().mockRejectedValue(notFoundErr),
        }),
      });

      const summary = await worker.reconcile();

      expect(summary.scanned).toBe(1);
      expect(summary.confirmed).toBe(0);
      expect(summary.flagged).toBe(1);

      // Verify update query adds review flag to metadata and notes
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("requires_manual_review"),
        ["tx-stale", expect.stringContaining("FLAGGED_FOR_MANUAL_REVIEW")],
      );
    });

    it("should keep unconfirmed transactions younger than 2 hours pending without flagging", async () => {
      const recentDate = new Date(Date.now() - 15 * 60 * 1000); // 15 mins ago (< 2 hours)
      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: "tx-recent",
              reference_number: "REF-RECENT",
              status: "pending",
              created_at: recentDate,
              metadata: { stellarTransactionHash: dummyHash },
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [],
        });

      const notFoundErr = new Error("Not Found") as any;
      notFoundErr.response = { status: 404 };
      mockHorizonServer.transactions.mockReturnValue({
        transaction: jest.fn().mockReturnValue({
          call: jest.fn().mockRejectedValue(notFoundErr),
        }),
      });

      const summary = await worker.reconcile();

      expect(summary.scanned).toBe(1);
      expect(summary.confirmed).toBe(0);
      expect(summary.flagged).toBe(0);

      // Should not have executed any UPDATE
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it("should reconcile and mark confirmed SEP-24 transactions", async () => {
      const recentDate = new Date(Date.now() - 20 * 60 * 1000);
      mockPool.query
        .mockResolvedValueOnce({
          rows: [], // No standard transactions
        })
        .mockResolvedValueOnce({
          // SEP-24 transactions
          rows: [
            {
              id: "sep24-1",
              status: "pending_anchor",
              stellar_transaction_id: dummyHash,
              created_at: recentDate,
            },
          ],
        })
        .mockResolvedValueOnce({
          // UPDATE sep24_transactions
          rowCount: 1,
        });

      mockHorizonServer.transactions.mockReturnValue({
        transaction: jest.fn().mockReturnValue({
          call: jest.fn().mockResolvedValue({
            successful: true,
            ledger_attr: 112233,
            created_at: recentDate.toISOString(),
          }),
        }),
      });

      const summary = await worker.reconcile();

      expect(summary.scanned).toBe(1);
      expect(summary.confirmed).toBe(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sep24_transactions"),
        ["sep24-1"],
      );
    });
  });

  describe("Cron Scheduling and runner", () => {
    it("should start and stop cron job with default 10-minute schedule", () => {
      const worker = new StellarReconciliationWorker({
        pool: {} as any,
        horizonServer: {} as any,
      });

      const task = worker.startCron("*/10 * * * *");
      expect(task).toBeDefined();
      expect(typeof task.stop).toBe("function");

      worker.stopCron();
    });

    it("should expose runStellarReconciliationJob wrapper function", async () => {
      expect(typeof runStellarReconciliationJob).toBe("function");
    });
  });
});
