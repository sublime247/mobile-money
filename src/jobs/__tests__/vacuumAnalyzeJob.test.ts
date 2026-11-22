/**
 * src/jobs/__tests__/vacuumAnalyzeJob.test.ts (#2481)
 *
 * Unit tests for the scheduled VACUUM (ANALYZE) maintenance job:
 *  - command execution is direct (no shell interpolation) and bounded
 *  - the script's structured JSON becomes a structured log entry
 *  - failures are logged and rethrown
 *  - the shell script is syntactically valid and targets the real high-churn
 *    table with before/after dead-tuple monitoring
 */

const mockExecFile = jest.fn();

jest.mock("node:child_process", () => {
  const actual =
    jest.requireActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

jest.mock("../../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import logger from "../../utils/logger";
import { runVacuumAnalyzeJob } from "../databaseBackupJob";

const SCRIPT_PATH = path.resolve(__dirname, "../../../scripts/vacuumTables.sh");

const RESULT = {
  event: "vacuum_analyze",
  status: "ok",
  tables: ["transactions"],
  vacuumed: ["transactions"],
  skipped: [],
  deadTuplesBefore: 5000,
  deadTuplesAfter: 12,
  spaceReclaimedBytes: 4096,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockExecFile.mockImplementation(
    (_file: unknown, _args: unknown, _options: unknown, cb: Function) => {
      cb(null, { stdout: `${JSON.stringify(RESULT)}\n`, stderr: "" });
    },
  );
});

describe("runVacuumAnalyzeJob (#2481)", () => {
  it("executes the script directly with a timeout and no shell wrapper", async () => {
    await runVacuumAnalyzeJob();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFile.mock.calls[0];
    expect(command).toBe("bash");
    expect(args).toEqual([SCRIPT_PATH]);
    expect(options).toMatchObject({
      timeout: expect.any(Number),
      maxBuffer: expect.any(Number),
    });
    expect(options).not.toHaveProperty("shell");
  });

  it("emits a structured log with duration, dead tuples and reclaimed space", async () => {
    await runVacuumAnalyzeJob();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "vacuum_analyze",
        status: "ok",
        deadTuplesBefore: 5000,
        deadTuplesAfter: 12,
        spaceReclaimedBytes: 4096,
        durationMs: expect.any(Number),
      }),
      expect.stringContaining("vacuum analyze maintenance completed"),
    );
  });

  it("logs and rethrows a script execution failure with its output", async () => {
    const failure = Object.assign(new Error("psql exited with status 1"), {
      stdout: '{"event":"vacuum_analyze","status":"error","error":"VACUUM failed"}\n',
    });
    mockExecFile.mockImplementation(
      (_file: unknown, _args: unknown, _options: unknown, cb: Function) => {
        cb(failure);
      },
    );

    await expect(runVacuumAnalyzeJob()).rejects.toThrow(
      "psql exited with status 1",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "vacuum_analyze",
        error: "psql exited with status 1",
        scriptOutput: expect.stringContaining("VACUUM failed"),
        durationMs: expect.any(Number),
      }),
      expect.stringContaining("vacuum analyze maintenance failed"),
    );
  });

  it("logs and rethrows malformed script output", async () => {
    mockExecFile.mockImplementation(
      (_file: unknown, _args: unknown, _options: unknown, cb: Function) => {
        cb(null, { stdout: "not json", stderr: "" });
      },
    );

    await expect(runVacuumAnalyzeJob()).rejects.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("vacuumTables.sh (#2481)", () => {
  it("is syntactically valid bash", () => {
    expect(() => execFileSync("bash", ["-n", SCRIPT_PATH])).not.toThrow();
  });

  it("vacuums the real high-churn table and monitors dead tuples", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf-8");

    expect(script).toContain("VACUUM (ANALYZE)");
    expect(script).toContain("pg_stat_user_tables");
    expect(script).toContain("pg_stat_clear_snapshot()");
    expect(script).toContain("VACUUM_TABLES:-transactions");
    expect(script).toContain("spaceReclaimedBytes");
    expect(script).not.toContain("idempotency_keys");
    expect(script).not.toContain("queue_jobs");
  });
});
