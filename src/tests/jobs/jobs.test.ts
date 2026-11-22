import { runCleanupJob } from "../../jobs/cleanupJob";
import { runReportJob } from "../../jobs/reportJob";
import { runStatusCheckJob } from "../../jobs/statusCheckJob";
import { runBalanceMonitorJob } from "../../jobs/balanceMonitorJob";
import { runHighValueComplianceReportJob } from "../../jobs/highValueComplianceReportJob";
import { startJobs } from "../../jobs/scheduler";

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    getJobs: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

jest.mock("../../graphql/redisPubSub", () => ({
  getRedisPubSub: () => ({
    publish: jest.fn(),
    asyncIterator: jest.fn(),
  }),
}));

jest.mock("../../workers/notificationWorker", () => ({
  startNotificationWorker: jest.fn().mockResolvedValue(undefined),
}));

// #2483: report reads go through a read-only client. Route it back to the
// existing pool mock so these job tests keep asserting the same queries.
jest.mock("../../database/readOnlyClient", () => ({
  withReadOnlyTransaction: jest.fn((run: (c: unknown) => unknown) =>
    run({ query: (...args: unknown[]) => mockQuery(...args) }),
  ),
}));

jest.mock("../../models/amlAlert", () => ({
  AMLAlertModel: jest.fn().mockImplementation(() => ({
    getAlertsByTransaction: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("../../services/complianceReportService", () => ({
  generateHighValueTransactionComplianceReport: jest.fn(),
}));

jest.mock("node-cron", () => ({
  validate: jest.fn(() => true),
  schedule: jest.fn(),
}));

import { pool, queryRead, queryWrite } from "../../config/database";
import cron from "node-cron";
import { generateHighValueTransactionComplianceReport } from "../../services/complianceReportService";

const mockQuery = pool.query as jest.Mock;
const mockQueryRead = queryRead as jest.Mock;
const mockQueryWrite = queryWrite as jest.Mock;
const mockGenerateHighValueReport =
  generateHighValueTransactionComplianceReport as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  mockQueryRead.mockReset();
  mockQueryWrite.mockReset();
  mockGenerateHighValueReport.mockReset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("runCleanupJob", () => {
  it("deletes old transactions and logs count", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 3 });
    mockQueryWrite.mockResolvedValueOnce({ rows: [{ released: 4 }] });
    await runCleanupJob();
    expect(mockQueryWrite).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Deleted 3"),
    );
  });

  it("uses LOG_RETENTION_DAYS env var", async () => {
    process.env.LOG_RETENTION_DAYS = "30";
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    mockQueryWrite.mockResolvedValueOnce({ rows: [{ released: 0 }] });
    await runCleanupJob();
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("30 days"));
    delete process.env.LOG_RETENTION_DAYS;
  });
});

describe("runReportJob", () => {
  it("logs no transactions when result is empty", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await runReportJob();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No transactions found"),
    );
  });

  it("logs each row when transactions exist", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          type: "deposit",
          status: "completed",
          count: 5,
          total_amount: "1000",
        },
      ],
    });
    await runReportJob();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("deposit"),
    );
  });
});

describe("runStatusCheckJob", () => {
  it("logs no stuck transactions when result is empty", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await runStatusCheckJob();
    expect(console.log).toHaveBeenCalledWith(
      "[status-check] No stuck transactions found",
    );
  });

  it("warns for each stuck transaction", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "1", reference_number: "TXN-001", created_at: new Date() }],
    });
    await runStatusCheckJob();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("1 stuck"),
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("id=1"));
  });

  it("uses STUCK_TRANSACTION_MINUTES env var", async () => {
    process.env.STUCK_TRANSACTION_MINUTES = "30";
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await runStatusCheckJob();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("30 minutes"),
    );
    delete process.env.STUCK_TRANSACTION_MINUTES;
  });
});

describe("runBalanceMonitorJob", () => {
  it("logs when no hot wallets configured", async () => {
    delete process.env.HOT_WALLET_PUBLIC_KEYS;
    delete process.env.BALANCE_THRESHOLD_XLM;
    await runBalanceMonitorJob();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No hot wallets configured"),
    );
  });
});

describe("runHighValueComplianceReportJob", () => {
  it("skips when there are no candidate transactions", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [] });

    await runHighValueComplianceReportJob();

    expect(mockQueryRead).toHaveBeenCalledTimes(1);
    expect(mockGenerateHighValueReport).not.toHaveBeenCalled();
    expect(mockQueryWrite).not.toHaveBeenCalled();
  });
});

describe("startJobs", () => {
  it("schedules all valid jobs", () => {
    (cron.validate as jest.Mock).mockReturnValue(true);
    startJobs();
    expect(cron.schedule).toHaveBeenCalled();
    expect((cron.schedule as jest.Mock).mock.calls.length).toBe(
      (cron.validate as jest.Mock).mock.calls.length,
    );
  });

  it("registers the high-value compliance backfill job", () => {
    (cron.validate as jest.Mock).mockReturnValue(true);
    startJobs();
    expect(cron.schedule).toHaveBeenCalledWith(
      "15 * * * *",
      expect.any(Function),
    );
  });

  it("skips jobs with invalid cron expressions", () => {
    (cron.validate as jest.Mock).mockReturnValue(false);
    startJobs();
    expect(cron.schedule).not.toHaveBeenCalled();
  });
});
