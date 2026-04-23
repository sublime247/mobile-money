import { runCleanupJob } from "./cleanupJob";
import { runReportJob } from "./reportJob";
import { runStatusCheckJob } from "./statusCheckJob";
import { runBalanceMonitorJob } from "./balanceMonitorJob";
import { startJobs } from "./scheduler";

// Mock the database pool
jest.mock("../config/database", () => ({
  pool: { query: jest.fn() },
}));

// Mock node-cron
jest.mock("node-cron", () => ({
  validate: jest.fn(() => true),
  schedule: jest.fn(),
}));

import { pool } from "../config/database";
import cron from "node-cron";

const mockQuery = pool.query as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// --- cleanupJob ---
describe("runCleanupJob", () => {
  it("deletes old transactions and logs count", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ released: 4 }] })
      .mockResolvedValueOnce({ rowCount: 3 });
    await runCleanupJob();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Deleted 3"),
    );
  });

  it("uses LOG_RETENTION_DAYS env var", async () => {
    process.env.LOG_RETENTION_DAYS = "30";
    mockQuery
      .mockResolvedValueOnce({ rows: [{ released: 0 }] })
      .mockResolvedValueOnce({ rowCount: 0 });
    await runCleanupJob();
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("30 days"));
    delete process.env.LOG_RETENTION_DAYS;
  });
});

// --- reportJob ---
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

// --- statusCheckJob ---
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

// --- balanceMonitorJob ---
describe("runBalanceMonitorJob", () => {
  beforeEach(() => {
    // Mock Stellar SDK
    jest.mock("stellar-sdk", () => ({
      Horizon: {
        Server: jest.fn().mockImplementation(() => ({
          loadAccount: jest.fn(),
        })),
      },
    }));
  });

  it("logs when no hot wallets configured", async () => {
    delete process.env.HOT_WALLET_PUBLIC_KEYS;
    delete process.env.BALANCE_THRESHOLD_XLM;
    await runBalanceMonitorJob();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No hot wallets configured"),
    );
  });

  it("logs when no thresholds configured", async () => {
    process.env.HOT_WALLET_PUBLIC_KEYS = "GABC123";
    delete process.env.BALANCE_THRESHOLD_XLM;
    await runBalanceMonitorJob();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No balance thresholds configured"),
    );
  });
});

// --- scheduler ---
describe("startJobs", () => {
  it("schedules all valid jobs", () => {
    (cron.validate as jest.Mock).mockReturnValue(true);
    startJobs();
    expect(cron.schedule).toHaveBeenCalledTimes(7);
    expect(cron.schedule).toHaveBeenCalledTimes(5);
  });

  it("skips jobs with invalid cron expressions", () => {
    (cron.validate as jest.Mock).mockReturnValue(false);
    startJobs();
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid cron expression"),
    );
  });
});
