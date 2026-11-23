import { pool } from "../../config/database";
import { TransactionStatus } from "../../models/transaction";
import {
  runMtnPendingDisbursementWatchdog,
  runStaleTransactionWatchdog,
} from "../staleTransactionWatchdog";
import * as metricsModule from "../../utils/metrics";

jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../utils/metrics", () => ({
  recordTransactionMetrics: jest.fn(),
}));

describe("MTN MoMo Status Polling Watchdog (#2271)", () => {
  let mockTransactionModel: any;
  let mockMtnProvider: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockTransactionModel = {
      updateStatus: jest.fn().mockResolvedValue(true),
      patchMetadata: jest.fn().mockResolvedValue({}),
    };

    mockMtnProvider = {
      getTransactionStatus: jest.fn(),
    };
  });

  it("reconciles stuck pending transaction to SUCCESS when callback was dropped and operator reports completed", async () => {
    const mockTx = {
      id: "tx-mtn-1",
      reference_number: "REF-MTN-001",
      provider: "mtn",
      currency: "XAF",
      metadata: { watchdog_poll_attempts: 1 },
      created_at: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago (> 3 min)
    };

    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [mockTx],
    });

    mockMtnProvider.getTransactionStatus.mockResolvedValueOnce({
      status: "completed",
      operatorCode: "SUCCESSFUL",
    });

    const result = await runMtnPendingDisbursementWatchdog({
      thresholdMinutes: 3,
      maxAttempts: 10,
      mtnProvider: mockMtnProvider,
      transactionModel: mockTransactionModel,
    });

    expect(result.resolvedSuccess).toBe(1);
    expect(result.resolvedFailed).toBe(0);

    // Verifies status transition to Completed
    expect(mockTransactionModel.updateStatus).toHaveBeenCalledWith(
      "tx-mtn-1",
      TransactionStatus.Completed,
    );

    // Verifies audit metadata recording
    expect(mockTransactionModel.patchMetadata).toHaveBeenCalledWith(
      "tx-mtn-1",
      expect.objectContaining({
        watchdog_poll_attempts: 2,
        watchdog_last_operator_status: "completed",
        watchdog_last_operator_response_code: "SUCCESSFUL",
        watchdog_terminal_status: "SUCCESS",
        watchdog_history: expect.arrayContaining([
          expect.objectContaining({
            attempt: 2,
            operator_status: "completed",
            operator_response_code: "SUCCESSFUL",
          }),
        ]),
      }),
    );

    // Verifies transaction metrics emitted
    expect(metricsModule.recordTransactionMetrics).toHaveBeenCalledWith({
      provider: "mtn",
      status: "completed",
      currency: "XAF",
    });
  });

  it("reconciles stuck pending transaction to FAILED when operator reports failed", async () => {
    const mockTx = {
      id: "tx-mtn-2",
      reference_number: "REF-MTN-002",
      provider: "mtn_momo",
      currency: "XAF",
      metadata: null,
      created_at: new Date(Date.now() - 4 * 60 * 1000),
    };

    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [mockTx],
    });

    mockMtnProvider.getTransactionStatus.mockResolvedValueOnce({
      status: "failed",
      operatorCode: "PAYER_NOT_FOUND",
    });

    const result = await runMtnPendingDisbursementWatchdog({
      thresholdMinutes: 3,
      maxAttempts: 10,
      mtnProvider: mockMtnProvider,
      transactionModel: mockTransactionModel,
    });

    expect(result.resolvedFailed).toBe(1);

    expect(mockTransactionModel.updateStatus).toHaveBeenCalledWith(
      "tx-mtn-2",
      TransactionStatus.Failed,
    );

    expect(mockTransactionModel.patchMetadata).toHaveBeenCalledWith(
      "tx-mtn-2",
      expect.objectContaining({
        watchdog_poll_attempts: 1,
        watchdog_last_operator_status: "failed",
        watchdog_last_operator_response_code: "PAYER_NOT_FOUND",
        watchdog_terminal_status: "FAILED",
      }),
    );

    expect(metricsModule.recordTransactionMetrics).toHaveBeenCalledWith({
      provider: "mtn_momo",
      status: "failed",
      currency: "XAF",
    });
  });

  it("leaves transaction in pending and increments poll attempts when operator still reports pending", async () => {
    const mockTx = {
      id: "tx-mtn-3",
      reference_number: "REF-MTN-003",
      provider: "mtn",
      currency: "XAF",
      metadata: { watchdog_poll_attempts: 3 },
      created_at: new Date(Date.now() - 6 * 60 * 1000),
    };

    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [mockTx],
    });

    mockMtnProvider.getTransactionStatus.mockResolvedValueOnce({
      status: "pending",
      operatorCode: "PENDING",
    });

    const result = await runMtnPendingDisbursementWatchdog({
      thresholdMinutes: 3,
      maxAttempts: 10,
      mtnProvider: mockMtnProvider,
      transactionModel: mockTransactionModel,
    });

    expect(result.stillPending).toBe(1);
    // Does NOT transition status
    expect(mockTransactionModel.updateStatus).not.toHaveBeenCalled();

    // Updates attempt count to 4 in metadata
    expect(mockTransactionModel.patchMetadata).toHaveBeenCalledWith(
      "tx-mtn-3",
      expect.objectContaining({
        watchdog_poll_attempts: 4,
        watchdog_last_operator_status: "pending",
      }),
    );
  });

  it("stops polling when max attempts count (default 10) is reached", async () => {
    const mockTx = {
      id: "tx-mtn-4",
      reference_number: "REF-MTN-004",
      provider: "mtn",
      currency: "XAF",
      metadata: { watchdog_poll_attempts: 10 }, // Already reached 10 attempts
      created_at: new Date(Date.now() - 30 * 60 * 1000),
    };

    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [mockTx],
    });

    const result = await runMtnPendingDisbursementWatchdog({
      thresholdMinutes: 3,
      maxAttempts: 10,
      mtnProvider: mockMtnProvider,
      transactionModel: mockTransactionModel,
    });

    expect(result.skippedMaxAttempts).toBe(1);
    // Provider status endpoint should NOT be called
    expect(mockMtnProvider.getTransactionStatus).not.toHaveBeenCalled();
    expect(mockTransactionModel.updateStatus).not.toHaveBeenCalled();
  });
});
