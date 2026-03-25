import { Pool, PoolClient } from "pg";

/**
 * Primary connection pool – handles all write operations
 * (INSERT, UPDATE, DELETE) and read operations when no replica is available.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Read replica connection pool – handles SELECT queries to take load off the
 * primary. If READ_REPLICA_URL is not configured, falls back to the primary.
 *
 * Multiple replica URLs can be provided as a comma-separated list in
 * READ_REPLICA_URL. The pool load-balances across all replicas via round-robin.
 */
const replicaUrls: string[] = process.env.READ_REPLICA_URL
  ? process.env.READ_REPLICA_URL.split(",").map((url) => url.trim())
  : [];

// Build an individual Pool for each replica URL
const replicaPools: Pool[] = replicaUrls.map(
  (url) =>
    new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    }),
);

// Track which replica to use next for round-robin load balancing
let replicaIndex = 0;

/**
 * Return the next replica pool in round-robin order.
 * Returns null if no replica pools are configured.
 */
function getNextReplicaPool(): Pool | null {
  if (replicaPools.length === 0) return null;
  const selected = replicaPools[replicaIndex % replicaPools.length];
  replicaIndex += 1;
  return selected;
}

/**
 * Execute a read-only SQL query against a replica pool if available.
 * If the replica is unreachable (pool error or connection failure) the query
 * automatically falls over to the primary pool so callers are unaffected.
 *
 * @param text   - The parameterised SQL query string
 * @param params - Optional query parameters
 */
export async function queryRead<T extends import("pg").QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  const replicaPool = getNextReplicaPool();

  if (replicaPool) {
    let client: PoolClient | null = null;
    try {
      client = await replicaPool.connect();
      const result = await client.query<T>(text, params);
      return result;
    } catch (err) {
      // Log replica failure and fall back to primary
      console.warn("Read replica query failed, falling back to primary:", err);
    } finally {
      client?.release();
    }
  }

  // Fall back: use primary pool
  return pool.query<T>(text, params);
}

/**
 * Execute a write SQL query (INSERT / UPDATE / DELETE) against the primary pool.
 *
 * @param text   - The parameterised SQL query string
 * @param params - Optional query parameters
 */
export async function queryWrite<T extends import("pg").QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Health check for all replica pools.
 * Returns an array of status objects – useful for monitoring endpoints.
 */
export async function checkReplicaHealth(): Promise<
  { url: string; healthy: boolean }[]
> {
  return Promise.all(
    replicaUrls.map(async (url, idx) => {
      let client: PoolClient | null = null;
      try {
        client = await replicaPools[idx].connect();
        await client.query("SELECT 1");
        return { url, healthy: true };
      } catch {
        return { url, healthy: false };
      } finally {
        client?.release();
      }
    }),
  );
}
