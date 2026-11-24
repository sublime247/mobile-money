import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { runLedgerReconciliationJob } from "../../jobs/ledgerReconciliationJob";
import { reconcileLedger } from "../../scripts/reconcile-ledger";
import { notifySlackAlert } from "../../services/loggers";

jest.mock("../../scripts/reconcile-ledger", () => ({
  reconcileLedger: jest.fn<any>(),
}));

jest.mock("../../services/loggers", () => ({
  notifySlackAlert: jest.fn<any>().mockResolvedValue(undefined),
}));

const mockedReconcileLedger = reconcileLedger as jest.MockedFunction<
  typeof reconcileLedger
>;
const mockedNotifySlackAlert = notifySlackAlert as jest.MockedFunction<
  typeof notifySlackAlert
>;

function makeReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    timestamp: new Date(),
    asOfDate: new Date(),
    ledgerBalanced: true,
    totalDebits: 100,
    totalCredits: 100,
    difference: 0,
    trialBalance: [],
    issues: [] as string[],
    warnings: [] as string[],
    summary: "OK",
    ...overrides,
  } as any;
}

describe("LedgerReconciliationJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does not alert when the ledger is balanced with no issues or warnings", async () => {
    mockedReconcileLedger.mockResolvedValue(makeReport());

    await runLedgerReconciliationJob();

    expect(mockedNotifySlackAlert).not.toHaveBeenCalled();
  });

  it("does not alert (only logs) when there are warnings but no issues", async () => {
    mockedReconcileLedger.mockResolvedValue(
      makeReport({ warnings: ["3 completed transactions have no ledger entries"] }),
    );

    await runLedgerReconciliationJob();

    expect(mockedNotifySlackAlert).not.toHaveBeenCalled();
  });

  it("sends a Slack alert when reconciliation finds issues", async () => {
    mockedReconcileLedger.mockResolvedValue(
      makeReport({
        ledgerBalanced: false,
        issues: ["Ledger not balanced: difference of 0.05"],
      }),
    );

    await runLedgerReconciliationJob();

    expect(mockedNotifySlackAlert).toHaveBeenCalledTimes(1);
    const [details, overrides] = mockedNotifySlackAlert.mock.calls[0];
    expect(details.error?.message).toContain("Ledger not balanced");
    expect(overrides).toEqual({ appName: "ledger-reconciliation" });
  });

  it("includes all issues in the alert message when there are multiple", async () => {
    mockedReconcileLedger.mockResolvedValue(
      makeReport({
        issues: ["Issue one", "Issue two"],
      }),
    );

    await runLedgerReconciliationJob();

    const [details] = mockedNotifySlackAlert.mock.calls[0];
    expect(details.error?.message).toContain("Issue one");
    expect(details.error?.message).toContain("Issue two");
  });

  it("sends a Slack alert and does not throw when reconcileLedger itself throws", async () => {
    mockedReconcileLedger.mockRejectedValue(new Error("db connection lost"));

    await expect(runLedgerReconciliationJob()).resolves.toBeUndefined();

    expect(mockedNotifySlackAlert).toHaveBeenCalledTimes(1);
    const [details] = mockedNotifySlackAlert.mock.calls[0];
    expect(details.error?.message).toBe("db connection lost");
  });

  it("wraps a non-Error rejection in a generic Error message", async () => {
    mockedReconcileLedger.mockRejectedValue("weird string rejection");

    await runLedgerReconciliationJob();

    const [details] = mockedNotifySlackAlert.mock.calls[0];
    expect(details.error?.message).toBe(
      "Ledger reconciliation job failed with an unknown error",
    );
  });
});
