jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));

const mockQuery = require("../../config/database").pool.query as jest.Mock;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});

  process.env.DATABASE_URL = "postgresql://test:password@localhost:5432/testdb";
  process.env.STELLAR_ISSUER_SECRET = "SA...";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.REFRESH_TOKEN_EXPIRES_IN = "86400";
  process.env.REFRESH_TOKEN_SECRET = "secret";
  process.env.REFRESH_TOKEN_ISSUER = "issuer";
  process.env.REFRESH_TOKEN_AUDIENCE = "audience";
  process.env.INDEX_REINDEX_JOB_ENABLED = "true";
  process.env.INDEX_REINDEX_CRON = "0 3 * * *";
  process.env.INDEX_REINDEX_MIN_SIZE_MB = "1";
  process.env.INDEX_REINDEX_MAX_SCAN_COUNT = "10";
  process.env.INDEX_REINDEX_MAX_ACTIVE_CONNECTIONS = "5";
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.DATABASE_URL;
  delete process.env.STELLAR_ISSUER_SECRET;
  delete process.env.REDIS_URL;
  delete process.env.REFRESH_TOKEN_EXPIRES_IN;
  delete process.env.REFRESH_TOKEN_SECRET;
  delete process.env.REFRESH_TOKEN_ISSUER;
  delete process.env.REFRESH_TOKEN_AUDIENCE;
  delete process.env.INDEX_REINDEX_JOB_ENABLED;
  delete process.env.INDEX_REINDEX_CRON;
  delete process.env.INDEX_REINDEX_MIN_SIZE_MB;
  delete process.env.INDEX_REINDEX_MAX_SCAN_COUNT;
  delete process.env.INDEX_REINDEX_MAX_ACTIVE_CONNECTIONS;
});

describe("runIndexReindexJob", () => {
  it("skips if this database is a replica", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ pg_is_in_recovery: true }] });
    const { runIndexReindexJob } = await import("../../jobs/indexReindexJob");

    await runIndexReindexJob();

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("Skipping because this database is a replica"),
    );
  });

  it("skips when active connections exceed threshold", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ pg_is_in_recovery: false }] })
      .mockResolvedValueOnce({ rows: [{ active_connections: "10" }] });
    const { runIndexReindexJob } = await import("../../jobs/indexReindexJob");

    await runIndexReindexJob();

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("Skipping due to active connections"),
    );
  });

  it("runs REINDEX CONCURRENTLY on eligible indexes", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ pg_is_in_recovery: false }] })
      .mockResolvedValueOnce({ rows: [{ active_connections: "0" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            schemaname: "public",
            tablename: "transactions",
            indexname: "idx_transactions_created_at",
            size_bytes: "104857600",
            size_mb: "100",
            idx_scan: 0,
            last_activity: "Never",
          },
        ],
      })
      .mockResolvedValueOnce({});

    const { runIndexReindexJob } = await import("../../jobs/indexReindexJob");

    await runIndexReindexJob();

    expect(mockQuery).toHaveBeenLastCalledWith(
      expect.stringContaining("REINDEX INDEX CONCURRENTLY"),
    );
  });
});
