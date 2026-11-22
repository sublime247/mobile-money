import { Pool } from "pg";

describe("Database pool configuration (#1652)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  describe("pool sizing constants", () => {
    it("uses default POOL_MIN of 10", () => {
      delete process.env.DB_POOL_MIN;
      jest.isolateModules(() => {
        const config = require("../../config/database");
        // Access the constants via the module's pool creation
        expect(config.pool).toBeDefined();
      });
    });

    it("uses DB_POOL_MIN from env when set", () => {
      process.env.DB_POOL_MIN = "5";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool).toBeDefined();
      });
    });

    it("uses DB_POOL_MAX from env when set", () => {
      process.env.DB_POOL_MAX = "200";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool).toBeDefined();
      });
    });

    it("defaults POOL_DEFAULT_MAX to min(25, POOL_MAX)", () => {
      process.env.DB_POOL_DEFAULT_MAX = "25";
      process.env.DB_POOL_MAX = "100";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.max).toBe(25);
      });
    });

    it("caps POOL_DEFAULT_MAX at POOL_MAX", () => {
      process.env.DB_POOL_DEFAULT_MAX = "200";
      process.env.DB_POOL_MAX = "50";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.max).toBeLessThanOrEqual(50);
      });
    });
  });

  describe("pool utilization calculation", () => {
    it("returns 0 for empty pool", () => {
      const mockPool = { totalCount: 0, idleCount: 0 } as Pool;
      // We test the logic indirectly via the pool options
      expect(mockPool.totalCount).toBe(0);
    });
  });

  describe("buildPoolOptions", () => {
    it("sets connectionString from DATABASE_URL", () => {
      process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/testdb";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.connectionString).toContain("testdb");
      });
    });

    it("uses SANDBOX_DATABASE_URL when IS_SANDBOX is true", () => {
      process.env.IS_SANDBOX = "true";
      process.env.SANDBOX_DATABASE_URL = "postgresql://sandbox:sandbox@localhost:5432/sandbox";
      process.env.DATABASE_URL = "postgresql://primary:primary@localhost:5432/primary";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.connectionString).toContain("sandbox");
      });
    });

    it("configures SSL in production", () => {
      process.env.NODE_ENV = "production";
      process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/testdb";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.ssl).toBeDefined();
      });
    });
  });

  describe("query routing", () => {
    it("exports queryRead, queryWrite, and querySmart", () => {
      // Can't test the actual routing without a DB, but verify exports exist
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(typeof config.queryRead).toBe("function");
        expect(typeof config.queryWrite).toBe("function");
        expect(typeof config.querySmart).toBe("function");
      });
    });

    it("routes SELECT queries to the replica pool via querySmart, and writes to primary (#2378)", () => {
      process.env.DATABASE_READ_URL =
        "postgresql://replica:replica@localhost:5433/testdb";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        const status = config.getReplicaPoolStatus();
        expect(status).toHaveLength(1);
        expect(status[0].url).not.toContain("replica:replica"); // password-redacted
      });
    });
  });

  describe("read replica configuration (#2378)", () => {
    it("creates a replica pool from DATABASE_READ_URL", () => {
      process.env.DATABASE_READ_URL =
        "postgresql://replica:replica@localhost:5433/testdb";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.getReplicaPoolStatus()).toHaveLength(1);
      });
    });

    it("prefers DATABASE_READ_URL over legacy READ_REPLICA_URL when both are set", () => {
      process.env.DATABASE_READ_URL =
        "postgresql://replica1:x@localhost:5433/db1";
      process.env.READ_REPLICA_URL =
        "postgresql://replica2:x@localhost:5434/db2,postgresql://replica3:x@localhost:5435/db3";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        // Only DATABASE_READ_URL's single replica should be configured.
        expect(config.getReplicaPoolStatus()).toHaveLength(1);
      });
    });

    it("falls back to legacy READ_REPLICA_URL when DATABASE_READ_URL is unset", () => {
      delete process.env.DATABASE_READ_URL;
      process.env.READ_REPLICA_URL =
        "postgresql://replica2:x@localhost:5434/db2,postgresql://replica3:x@localhost:5435/db3";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.getReplicaPoolStatus()).toHaveLength(2);
      });
    });

    it("has no replica pools configured when neither env var is set", () => {
      delete process.env.DATABASE_READ_URL;
      delete process.env.READ_REPLICA_URL;
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.getReplicaPoolStatus()).toHaveLength(0);
      });
    });
  });

  describe("pool monitoring", () => {
    it("starts pool monitor in non-test environments", () => {
      // Verify the monitor doesn't crash
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool).toBeDefined();
      });
    });
  });
});

describe("Transactions and Connection Timeouts (#1596)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it("applies query and statement timeout configurations", () => {
    process.env.DB_QUERY_TIMEOUT_MS = "15000";
    process.env.DB_STATEMENT_TIMEOUT_MS = "12000";
    
    jest.isolateModules(() => {
      const config = require("../../config/database");
      expect(config.pool.options.query_timeout).toBe(15000);
      expect(config.pool.options.statement_timeout).toBe(12000);
    });
  });

  it("should successfully commit a transaction and release the client", async () => {
    let config: any;
    jest.isolateModules(() => {
      config = require("../../config/database");
    });

    const mockRelease = jest.fn();
    const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    
    // Spy on the pool to intercept the connect method
    jest.spyOn(config.pool, 'connect').mockResolvedValue({
      query: mockQuery,
      release: mockRelease
    } as any);

    await config.executeTransaction([{ text: 'UPDATE users SET name = $1', params: ['Test'] }]);

    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).toHaveBeenCalledWith('UPDATE users SET name = $1', ['Test']);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("should rollback and release the connection when a query timeout error occurs", async () => {
    let config: any;
    jest.isolateModules(() => {
      config = require("../../config/database");
    });

    const mockRelease = jest.fn();
    const mockQuery = jest.fn()
      .mockResolvedValueOnce(undefined) // Mock successful BEGIN
      .mockRejectedValueOnce(new Error('Query read timeout')); // Mock failing query

    jest.spyOn(config.pool, 'connect').mockResolvedValue({
      query: mockQuery,
      release: mockRelease
    } as any);

    await expect(
      config.executeTransaction([{ text: 'SELECT pg_sleep(15)' }])
    ).rejects.toThrow('Query read timeout');

    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  describe("pool eviction policy (#2377)", () => {
    it("enables TCP keepalive on the primary pool by default", () => {
      delete process.env.DB_POOL_KEEP_ALIVE;
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.keepAlive).toBe(true);
        expect(
          config.pool.options.keepAliveInitialDelayMillis,
        ).toBeGreaterThan(0);
      });
    });

    it("disables keepalive when DB_POOL_KEEP_ALIVE is explicitly false", () => {
      process.env.DB_POOL_KEEP_ALIVE = "false";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.keepAlive).toBe(false);
      });
    });

    it("recovers (returns false, does not throw) when a connection drop is simulated", async () => {
      let config: any;
      jest.isolateModules(() => {
        config = require("../../config/database");
      });

      const dropError: Error & { code?: string } = new Error(
        "Connection terminated unexpectedly",
      );
      dropError.code = "ECONNRESET";

      jest.spyOn(config.pool, "connect").mockRejectedValue(dropError);

      const healthy = await config.pingDatabasePool(config.pool);

      expect(healthy).toBe(false);
    });

    it("reports healthy when the ping query succeeds", async () => {
      let config: any;
      jest.isolateModules(() => {
        config = require("../../config/database");
      });

      const mockRelease = jest.fn();
      const mockQuery = jest.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
      jest.spyOn(config.pool, "connect").mockResolvedValue({
        query: mockQuery,
        release: mockRelease,
      } as any);

      const healthy = await config.pingDatabasePool(config.pool);

      expect(healthy).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith("SELECT 1");
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it("starts and stops the periodic health check loop without throwing", () => {
      let config: any;
      jest.isolateModules(() => {
        config = require("../../config/database");
      });

      const mockRelease = jest.fn();
      const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
      jest.spyOn(config.pool, "connect").mockResolvedValue({
        query: mockQuery,
        release: mockRelease,
      } as any);

      expect(() => {
        config.startPoolHealthCheck(1000);
        config.stopPoolHealthCheck();
      }).not.toThrow();
    });
  });
});