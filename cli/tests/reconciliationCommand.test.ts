// Set required environment variables before importing anything from src
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.STELLAR_ISSUER_SECRET = "SDNJSSOBC5ZOT65OH2U2KBA637777777777777777777777777777777";

import assert from "node:assert/strict";
import test from "node:test";

test("reconciliationCommand test suite", async (t) => {
  const {
    executeReconciliationRun,
    buildReconciliationTable,
  } = await import("../src/commands/reconciliationRun");
  const {
    runOnDemandReconciliation,
    isValidDateString,
  } = await import("../../src/services/accountingReconciliation");

  await t.test("isValidDateString validates YYYY-MM-DD format correctly", () => {
    assert.equal(isValidDateString("2026-04-01"), true);
    assert.equal(isValidDateString("2026-12-31"), true);
    assert.equal(isValidDateString("invalid-date"), false);
    assert.equal(isValidDateString("2026/04/01"), false);
    assert.equal(isValidDateString("01-04-2026"), false);
  });

  await t.test("executeReconciliationRun rejects when neither date nor date range is provided", async () => {
    await assert.rejects(
      async () => {
        await executeReconciliationRun({});
      },
      {
        message: /Must provide either --date YYYY-MM-DD or both --start-date and --end-date/,
      },
    );
  });

  await t.test("executeReconciliationRun rejects when only start-date is provided without end-date", async () => {
    await assert.rejects(
      async () => {
        await executeReconciliationRun({ startDate: "2026-04-01" });
      },
      {
        message: /Must provide either --date YYYY-MM-DD or both --start-date and --end-date/,
      },
    );
  });

  await t.test("runOnDemandReconciliation rejects invalid date formats", async () => {
    await assert.rejects(
      async () => {
        await runOnDemandReconciliation({ date: "not-a-date" });
      },
      {
        message: /Invalid date format/,
      },
    );
  });

  await t.test("runOnDemandReconciliation rejects inverted date range (start > end)", async () => {
    await assert.rejects(
      async () => {
        await runOnDemandReconciliation({
          startDate: "2026-05-01",
          endDate: "2026-04-01",
        });
      },
      {
        message: /Start date must be earlier than or equal to end date/,
      },
    );
  });

  await t.test("runOnDemandReconciliation reconciles transactions comparing database, Horizon, and Telco", async () => {
    const mockTransactions = [
      {
        id: "tx-1",
        reference_number: "REF-001",
        amount: "1000.00",
        status: "completed",
        stellar_transaction_hash: "a".repeat(64),
        metadata: {
          provider_status: "SUCCESS",
          provider_amount: "1000.00",
        },
      },
      {
        id: "tx-2",
        reference_number: "REF-002",
        amount: "500.00",
        status: "completed",
        stellar_transaction_hash: "b".repeat(64),
        metadata: {
          provider_status: "SUCCESS",
          provider_amount: "500.00",
        },
      },
      {
        id: "tx-3",
        reference_number: "REF-003",
        amount: "250.00",
        status: "completed",
        stellar_transaction_hash: "c".repeat(64),
        metadata: {
          provider_status: "SUCCESS",
          provider_amount: "250.00",
        },
      },
      {
        id: "tx-4",
        reference_number: "REF-004",
        amount: "300.00",
        status: "completed",
        stellar_transaction_hash: "d".repeat(64),
        metadata: {
          provider_status: "FAILED",
          provider_amount: "300.00",
        },
      },
    ];

    const fakePool = {
      query: async () => ({ rows: mockTransactions }),
    };

    const fakeHorizon = {
      transactions: () => ({
        transaction: (hash: string) => ({
          call: async () => {
            if (hash === "c".repeat(64)) {
              const err: any = new Error("Not Found");
              err.response = { status: 404 };
              throw err;
            }
            return {
              successful: true,
              ledger: 123456,
              created_at: new Date().toISOString(),
            };
          },
        }),
      }),
    };

    const summary = await runOnDemandReconciliation({
      startDate: "2026-04-01",
      endDate: "2026-04-02",
      pool: fakePool,
      horizonServer: fakeHorizon,
    });

    assert.equal(summary.totalCount, 4);
    assert.equal(summary.totalVolume, 2050);
    assert.equal(summary.matchedCount, 2);
    assert.equal(summary.discrepancyCount, 2);
    assert.equal(summary.discrepancies.length, 2);

    const horizonMismatch = summary.discrepancies.find((d) => d.type === "horizon_mismatch");
    assert.ok(horizonMismatch, "Expected horizon_mismatch discrepancy");
    assert.equal(horizonMismatch?.id, "tx-3");

    const telcoMismatch = summary.discrepancies.find((d) => d.type === "telco_mismatch");
    assert.ok(telcoMismatch, "Expected telco_mismatch discrepancy");
    assert.equal(telcoMismatch?.id, "tx-4");
  });

  await t.test("buildReconciliationTable formats summary table with total volume, matched count, and discrepancy count", () => {
    const summary = {
      startDate: "2026-04-01",
      endDate: "2026-04-01",
      totalVolume: 12500.5,
      totalCount: 15,
      matchedCount: 14,
      discrepancyCount: 1,
      discrepancies: [
        {
          id: "tx-disc-1",
          referenceNumber: "REF-DISC",
          type: "amount_mismatch" as const,
          description: "Amount mismatch detected",
          internalAmount: 500,
          externalAmount: 400,
          internalStatus: "completed",
        },
      ],
    };

    const tableStr = buildReconciliationTable(summary);

    assert.ok(tableStr.includes("Total Volume"), "Table must contain Total Volume header");
    assert.ok(tableStr.includes("Matched Count"), "Table must contain Matched Count header");
    assert.ok(tableStr.includes("Discrepancy Count"), "Table must contain Discrepancy Count header");
    assert.ok(tableStr.includes("12,500.50"), "Table must format total volume");
    assert.ok(tableStr.includes("14"), "Table must display matched count");
    assert.ok(tableStr.includes("1"), "Table must display discrepancy count");
  });

  await t.test("executeReconciliationRun prints summary and outputs structured result", async () => {
    let printed = "";
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      printed += args.join(" ") + "\n";
    };

    try {
      const fakeRunner = async () => ({
        startDate: "2026-04-01",
        endDate: "2026-04-01",
        totalVolume: 1000,
        totalCount: 1,
        matchedCount: 1,
        discrepancyCount: 0,
        discrepancies: [],
      });

      const result = await executeReconciliationRun(
        { date: "2026-04-01" },
        fakeRunner as any,
      );

      assert.equal(result.matchedCount, 1);
      assert.equal(result.discrepancyCount, 0);
      assert.ok(printed.includes("On-Demand Ledger Reconciliation Summary"));
      assert.ok(printed.includes("Matched Count"));
      assert.ok(printed.includes("✓ All transactions matched"));
    } finally {
      console.log = originalLog;
    }
  });
});
