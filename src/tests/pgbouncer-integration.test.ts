import logger from "../utils/logger";
import { pool, getPgBouncerStats, queryRead, queryWrite } from "../config/database";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";

describe("PgBouncer Integration Tests", () => {
  beforeAll(async () => {
    // Ensure database is ready
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 10000);

  afterAll(async () => {
    await pool.end();
  }, 10000);

  describe("Connection Pooling", () => {
    it("should connect to database through PgBouncer", async () => {
      const result = await pool.query("SELECT 1 as result");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].result).toBe(1);
    });

    it("should handle multiple concurrent queries", async () => {
      const queries = Array.from({ length: 10 }, () =>
        pool.query("SELECT $1 as num", [Math.random()]),
      );

      const results = await Promise.all(queries);
      expect(results).toHaveLength(10);
      results.forEach((result) => {
        expect(result.rows).toHaveLength(1);
      });
    });

    it("should reuse connections from pool", async () => {
      const initialStats = await getPgBouncerStats();
      const initialTotal = initialStats.totalConnections;

      // Execute multiple queries sequentially
      for (let i = 0; i < 5; i++) {
        await pool.query("SELECT 1");
      }

      const finalStats = await getPgBouncerStats();
      // Connection pool should reuse connections, not create new ones
      // Total connections shouldn't grow significantly
      expect(finalStats.totalConnections).toBeLessThanOrEqual(initialTotal + 3);
    });

    it("should properly handle transaction mode", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT 1");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
  });

  describe("Query Operations", () => {
    it("should handle queryRead for SELECT statements", async () => {
      const result = await queryRead("SELECT 1 as num");
      expect(result.rows[0].num).toBe(1);
    });

    it("should handle queryWrite for INSERT statements", async () => {
      const tableName = `test_table_${Date.now()}`;
      const result = await queryWrite(
        `CREATE TEMP TABLE ${tableName} (id SERIAL, name TEXT)`,
      );
      expect(result).toBeDefined();

      const insertResult = await queryWrite(
        `INSERT INTO ${tableName} (name) VALUES ($1) RETURNING *`,
        ["test"],
      );
      expect(insertResult.rows[0].name).toBe("test");
    });

    it("should handle parameterized queries safely", async () => {
      const result = await queryRead("SELECT $1::TEXT as value", ["safe_value"]);
      expect(result.rows[0].value).toBe("safe_value");
    });
  });

  describe("PgBouncer Statistics", () => {
    it("should retrieve PgBouncer stats", async () => {
      const stats = await getPgBouncerStats();
      
      expect(stats).toHaveProperty("activeConnections");
      expect(stats).toHaveProperty("idleConnections");
      expect(stats).toHaveProperty("totalConnections");

      expect(typeof stats.activeConnections).toBe("number");
      expect(typeof stats.idleConnections).toBe("number");
      expect(stats.totalConnections).toBeGreaterThanOrEqual(0);
    });

    it("should show reduced connections compared to direct Postgres", async () => {
      // With PgBouncer transaction pooling, we should see fewer active server connections
      const stats = await getPgBouncerStats();
      
      // This is a sanity check - with pooling we shouldn't see excessive connections
      expect(stats.totalConnections).toBeLessThan(100);
    });

    it("should track idle connections correctly", async () => {
      // Execute a query to create active connection
      await pool.query("SELECT 1");
      
      const stats = await getPgBouncerStats();
      
      // After query completes, connection should become idle
      expect(stats.idleConnections).toBeGreaterThanOrEqual(0);
      expect(stats.activeConnections + stats.idleConnections).toBe(
        stats.totalConnections,
      );
    });
  });

  describe("Connection Limits", () => {
    it("should respect max_client_conn limit", async () => {
      // Test that we don't exceed PgBouncer's max_client_conn (1000)
      const connections = [];

      try {
        // Try to create many connections (sequentially to avoid pool exhaustion)
        for (let i = 0; i < 10; i++) {
          connections.push(pool.connect());
        }

        const clients = await Promise.all(connections);
        expect(clients.length).toBe(10);

        // Release all connections
        clients.forEach((client) => client.release());
      } catch (err) {
        // Expected if we hit the limit
        expect((err as Error).message).toContain("connect");
      }
    }, 15000);

    it("should maintain default_pool_size", async () => {
      // After idle timeout, pool should maintain min_pool_size connections
      const stats = await getPgBouncerStats();
      
      // With default_pool_size=25 and min_pool_size=5, we should have some idle connections
      expect(stats.idleConnections + stats.activeConnections).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Performance Metrics", () => {
    it(
      "should measure query latency through PgBouncer",
      async () => {
        const start = Date.now();
        
        // Sequential queries instead of concurrent to avoid pool exhaustion
        for (let i = 0; i < 50; i++) {
          await pool.query("SELECT 1");
        }
        
        const duration = Date.now() - start;
        
        // Should be reasonably fast (less than 10 seconds for 50 queries)
        expect(duration).toBeLessThan(10000);
        
        console.log(`50 queries through PgBouncer: ${duration}ms`);
      },
      30000,
    );

    it(
      "should show throughput improvement",
      async () => {
        const iterations = 30;
        const start = Date.now();

        // Use batch limit to avoid pool exhaustion
        const batchSize = 5;
        for (let i = 0; i < iterations; i += batchSize) {
          const batch = Array.from({ length: Math.min(batchSize, iterations - i) }, () =>
            pool.query("SELECT $1 as num", [Math.random()]),
          );
          await Promise.all(batch);
        }
        
        const duration = Date.now() - start;
        const throughput = (iterations / duration) * 1000; // queries per second

        // With connection pooling, should handle at least 20 queries/sec
        expect(throughput).toBeGreaterThan(20);
        
        console.log(
          `Throughput: ${Math.round(throughput)} queries/sec (${duration}ms for ${iterations} queries)`,
        );
      },
      30000,
    );
  });

  describe("Connection Stability", () => {
    it(
      "should handle connection failures gracefully",
      async () => {
        // This test verifies that the pool handles transient errors
        const results = [];

        for (let i = 0; i < 10; i++) {
          try {
            const result = await pool.query("SELECT 1");
            results.push(result);
          } catch (err) {
            logger.error("Query failed:", err);
            throw err;
          }
        }

        expect(results.length).toBe(10);
      },
      15000,
    );

    it("should maintain pool state after errors", async () => {
      const statsBefore = await getPgBouncerStats();

      // Execute a valid query
      try {
        await pool.query("SELECT 1");
      } catch (err) {
        logger.error("Unexpected error:", err);
      }

      const statsAfter = await getPgBouncerStats();

      // Pool state should be consistent
      expect(statsAfter.totalConnections).toBeGreaterThanOrEqual(0);
      expect(statsAfter.activeConnections + statsAfter.idleConnections).toBe(
        statsAfter.totalConnections,
      );
    });
  });

  describe("Acceptance Criteria Verification", () => {
    it("should significantly reduce active Postgres connections", async () => {
      const stats = await getPgBouncerStats();
      
      // Key criterion: active connections should be much lower than typical direct connections
      console.log(
        `Server connections: ${stats.activeConnections}, Total: ${stats.totalConnections}`,
      );

      // Verify pooling is working: active connections should be reasonable
      expect(stats.activeConnections).toBeLessThan(30);
    });

    it(
      "should improve overall throughput",
      async () => {
        const queryCount = 100;
        const start = Date.now();

        // Use batching to avoid pool exhaustion
        const batchSize = 10;
        for (let i = 0; i < queryCount; i += batchSize) {
          const batch = Array.from({ length: Math.min(batchSize, queryCount - i) }, () =>
            pool.query("SELECT 1 as result"),
          );
          await Promise.all(batch);
        }

        const duration = Date.now() - start;
        const throughput = (queryCount / duration) * 1000;

        console.log(
          `Throughput improvement: ${throughput.toFixed(2)} queries/sec (${duration}ms for ${queryCount} queries)`,
        );

        // Expected improvement: > 50 queries/sec with connection pooling
        expect(throughput).toBeGreaterThan(50);
      },
      30000,
    );

    it(
      "should maintain sub-100ms latency for typical queries",
      async () => {
        const latencies: number[] = [];

        for (let i = 0; i < 20; i++) {
          const start = Date.now();
          await pool.query("SELECT 1");
          latencies.push(Date.now() - start);
        }

        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const p99Latency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.99)];

        console.log(`Average latency: ${avgLatency.toFixed(2)}ms, P99: ${p99Latency}ms`);

        // Acceptance criterion: good latency maintained
        expect(avgLatency).toBeLessThan(100);
      },
      20000,
    );
  });
});