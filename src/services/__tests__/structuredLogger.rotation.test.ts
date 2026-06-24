import fs from "fs";
import os from "os";
import path from "path";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("structured logger rolling mirror", () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    LOG_FILE_PATH: process.env.LOG_FILE_PATH,
    LOG_SHARD_MAX_BYTES: process.env.LOG_SHARD_MAX_BYTES,
    LOG_SHARD_RETENTION_DAYS: process.env.LOG_SHARD_RETENTION_DAYS,
    LOG_SHARD_COMPRESS: process.env.LOG_SHARD_COMPRESS,
  };

  afterEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    process.env.LOG_FILE_PATH = originalEnv.LOG_FILE_PATH;
    process.env.LOG_SHARD_MAX_BYTES = originalEnv.LOG_SHARD_MAX_BYTES;
    process.env.LOG_SHARD_RETENTION_DAYS = originalEnv.LOG_SHARD_RETENTION_DAYS;
    process.env.LOG_SHARD_COMPRESS = originalEnv.LOG_SHARD_COMPRESS;
  });

  it("rotates oversized local logs into compressed shards", () => {
    const dir = tempDir("mobile-money-logs-");
    const logFilePath = path.join(dir, "app.log");

    process.env.NODE_ENV = "development";
    process.env.LOG_FILE_PATH = logFilePath;
    process.env.LOG_SHARD_MAX_BYTES = "1024";
    process.env.LOG_SHARD_RETENTION_DAYS = "30";
    process.env.LOG_SHARD_COMPRESS = "true";

    jest.resetModules();

    const {
      logStructured,
      closeStructuredLogStream,
      getStructuredLogMirrorMode,
      getStructuredLogShardPath,
    } = require("../structuredLogger") as typeof import("../structuredLogger");

    expect(getStructuredLogMirrorMode()).toBe("rolling");

    const payload = {
      event: "log.shard.test",
      message: "x".repeat(900),
      details: { note: "y".repeat(256) },
    };

    logStructured("info", payload);
    logStructured("info", payload);
    closeStructuredLogStream();

    const shardPath = getStructuredLogShardPath(new Date().toISOString().slice(0, 10), 1);

    expect(fs.existsSync(logFilePath)).toBe(true);
    expect(fs.existsSync(`${shardPath}.gz`)).toBe(true);

    const activeLog = fs.readFileSync(logFilePath, "utf8");
    expect(activeLog).toContain("log.shard.test");
  });
});
