import {
  runAirtelReconciliationWorker,
  AirtelReconciliationWorkerOptions,
} from "../../src/workers/airtelReconciliation";
import { TransactionStatus } from "../../src/models/transaction";

type Row = {
  id: string;
  reference_number: string;
  provider_reference: string | null;
  amount: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
};

function makeDb(rows: Row[]) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

function makeAirtelService(
  statusByReference: Record<string, "completed" | "failed" | "pending" | "unknown">,
) {
  return {
    getDisbursementStatus: jest.fn(async (reference: string) => ({
      status: statusByReference[reference] ?? "unknown",
    })),
  };
}

function makeTransactionModel() {
  return { updateStatus: jest.fn().mockResolvedValue(true) };
}

function baseOptions(
  overrides: Partial<AirtelReconciliationWorkerOptions> = {},
): AirtelReconciliationWorkerOptions {
  return {
    pollDelayMs: 60_000,
    minIntervalMs: 0,
    notify: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("runAirtelReconciliationWorker", () => {
  it("returns zeroed stats and does not call the provider when nothing is pending", async () => {
    const db = makeDb([]);
    const airtelService = makeAirtelService({});
    const transactionModel = makeTransactionModel();

    const stats = await runAirtelReconciliationWorker(
      baseOptions({ db, airtelService, transactionModel }),
    );

    expect(stats).toEqual({
      checked: 0,
      completed: 0,
      failed: 0,
      stillPending: 0,
      errors: 0,
    });
    expect(airtelService.getDisbursementStatus).not.toHaveBeenCalled();
  });

  it("queries only pending Airtel withdrawals older than the poll delay", async () => {
    const db = makeDb([]);
    await runAirtelReconciliationWorker(
      baseOptions({
        db,
        airtelService: makeAirtelService({}),
        transactionModel: makeTransactionModel(),
        pollDelayMs: 60_000,
      }),
    );

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'pending'"),
      [60_000, expect.any(Number)],
    );
    expect(db.query.mock.calls[0][0]).toEqual(
      expect.stringContaining("type = 'withdraw'"),
    );
    expect(db.query.mock.calls[0][0]).toEqual(
      expect.stringContaining("provider = 'airtel'"),
    );
  });

  it("marks a disbursement completed and updates the transaction status", async () => {
    const row: Row = {
      id: "tx-1",
      reference_number: "REF-1",
      provider_reference: "AIRTEL-REF-1",
      amount: "500",
      metadata: {},
      created_at: new Date(),
    };
    const db = makeDb([row]);
    const airtelService = makeAirtelService({ "AIRTEL-REF-1": "completed" });
    const transactionModel = makeTransactionModel();
    const notify = jest.fn().mockResolvedValue(undefined);

    const stats = await runAirtelReconciliationWorker(
      baseOptions({ db, airtelService, transactionModel, notify }),
    );

    expect(airtelService.getDisbursementStatus).toHaveBeenCalledWith(
      "AIRTEL-REF-1",
    );
    expect(transactionModel.updateStatus).toHaveBeenCalledWith(
      "tx-1",
      TransactionStatus.Completed,
    );
    expect(stats).toMatchObject({ checked: 1, completed: 1 });
    // No sep31 metadata on this transaction — no completion notification.
    expect(notify).not.toHaveBeenCalled();
  });

  it("triggers SEP-31 completion notification for a SEP-31-linked disbursement", async () => {
    const row: Row = {
      id: "tx-2",
      reference_number: "REF-2",
      provider_reference: "AIRTEL-REF-2",
      amount: "1000",
      metadata: { sep31: { stellar_account_id: "GABC...", callback_url: "https://anchor.example/cb" } },
      created_at: new Date(),
    };
    const db = makeDb([row]);
    const airtelService = makeAirtelService({ "AIRTEL-REF-2": "completed" });
    const transactionModel = makeTransactionModel();
    const notify = jest.fn().mockResolvedValue(undefined);

    await runAirtelReconciliationWorker(
      baseOptions({ db, airtelService, transactionModel, notify }),
    );

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tx-2", amount: "1000" }),
      "completed",
      expect.objectContaining({ sep31: expect.any(Object) }),
    );
  });

  it("marks a disbursement failed and updates the transaction status", async () => {
    const row: Row = {
      id: "tx-3",
      reference_number: "REF-3",
      provider_reference: "AIRTEL-REF-3",
      amount: "250",
      metadata: null,
      created_at: new Date(),
    };
    const db = makeDb([row]);
    const airtelService = makeAirtelService({ "AIRTEL-REF-3": "failed" });
    const transactionModel = makeTransactionModel();

    const stats = await runAirtelReconciliationWorker(
      baseOptions({ db, airtelService, transactionModel }),
    );

    expect(transactionModel.updateStatus).toHaveBeenCalledWith(
      "tx-3",
      TransactionStatus.Failed,
    );
    expect(stats).toMatchObject({ checked: 1, failed: 1 });
  });

  it("leaves a still-pending/unknown disbursement untouched for the next run", async () => {
    const row: Row = {
      id: "tx-4",
      reference_number: "REF-4",
      provider_reference: "AIRTEL-REF-4",
      amount: "300",
      metadata: null,
      created_at: new Date(),
    };
    const db = makeDb([row]);
    const airtelService = makeAirtelService({ "AIRTEL-REF-4": "pending" });
    const transactionModel = makeTransactionModel();

    const stats = await runAirtelReconciliationWorker(
      baseOptions({ db, airtelService, transactionModel }),
    );

    expect(transactionModel.updateStatus).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ checked: 1, stillPending: 1 });
  });

  it("falls back to the internal reference_number when provider_reference is absent", async () => {
    const row: Row = {
      id: "tx-5",
      reference_number: "REF-5",
      provider_reference: null,
      amount: "100",
      metadata: null,
      created_at: new Date(),
    };
    const db = makeDb([row]);
    const airtelService = makeAirtelService({ "REF-5": "completed" });
    const transactionModel = makeTransactionModel();

    await runAirtelReconciliationWorker(
      baseOptions({ db, airtelService, transactionModel }),
    );

    expect(airtelService.getDisbursementStatus).toHaveBeenCalledWith("REF-5");
  });

  it("counts a provider lookup error without throwing, and continues the run", async () => {
    const rows: Row[] = [
      {
        id: "tx-err",
        reference_number: "REF-ERR",
        provider_reference: "AIRTEL-REF-ERR",
        amount: "100",
        metadata: null,
        created_at: new Date(),
      },
      {
        id: "tx-ok",
        reference_number: "REF-OK",
        provider_reference: "AIRTEL-REF-OK",
        amount: "200",
        metadata: null,
        created_at: new Date(),
      },
    ];
    const db = makeDb(rows);
    const transactionModel = makeTransactionModel();
    const airtelService = {
      getDisbursementStatus: jest
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce({ status: "completed" }),
    };

    const stats = await runAirtelReconciliationWorker(
      baseOptions({ db, airtelService, transactionModel }),
    );

    expect(stats.errors).toBe(1);
    expect(stats.completed).toBe(1);
    expect(transactionModel.updateStatus).toHaveBeenCalledTimes(1);
    expect(transactionModel.updateStatus).toHaveBeenCalledWith(
      "tx-ok",
      TransactionStatus.Completed,
    );
  });

  it("stops issuing provider calls once the per-run rate limit is reached", async () => {
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
      id: `tx-${i}`,
      reference_number: `REF-${i}`,
      provider_reference: `AIRTEL-REF-${i}`,
      amount: "100",
      metadata: null,
      created_at: new Date(),
    }));
    const db = makeDb(rows);
    const transactionModel = makeTransactionModel();
    const airtelService = makeAirtelService(
      Object.fromEntries(rows.map((r) => [r.provider_reference!, "completed"])),
    );

    const stats = await runAirtelReconciliationWorker(
      baseOptions({
        db,
        airtelService,
        transactionModel,
        maxCallsPerRun: 2,
      }),
    );

    expect(airtelService.getDisbursementStatus).toHaveBeenCalledTimes(2);
    expect(stats.checked).toBe(2);
  });

  it("does not notify the anchor when the SEP-31 notification itself throws", async () => {
    const row: Row = {
      id: "tx-notify-fail",
      reference_number: "REF-NF",
      provider_reference: "AIRTEL-REF-NF",
      amount: "500",
      metadata: { sep31: { stellar_account_id: "GABC..." } },
      created_at: new Date(),
    };
    const db = makeDb([row]);
    const airtelService = makeAirtelService({ "AIRTEL-REF-NF": "completed" });
    const transactionModel = makeTransactionModel();
    const notify = jest.fn().mockRejectedValue(new Error("webhook queue down"));

    // Should not throw despite the notification failure — the transaction
    // status update must still have succeeded.
    await expect(
      runAirtelReconciliationWorker(
        baseOptions({ db, airtelService, transactionModel, notify }),
      ),
    ).resolves.toMatchObject({ completed: 1 });

    expect(transactionModel.updateStatus).toHaveBeenCalledWith(
      "tx-notify-fail",
      TransactionStatus.Completed,
    );
  });
});
