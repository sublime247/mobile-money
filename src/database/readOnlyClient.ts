import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { getReadClient } from "../config/database";
import { ERROR_CODES } from "../constants/errorCodes";
import { BusinessLogicError } from "../utils/errors";
import { getQueryCommand, isReadOnlyQuery } from "../utils/readOnlyDetector";
import logger from "../utils/logger";

/**
 * The only query surface handed to reporting/export reads. Writes are rejected
 * here, before they ever reach Postgres (#2483).
 */
export interface ReadOnlyClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface ReadOnlyTransactionOptions {
  /** Injectable for unit tests; defaults to a replica-first primary fallback. */
  clientFactory?: () => Promise<PoolClient>;
}

/**
 * Runs reporting/export reads inside `BEGIN READ ONLY`.
 *
 * One client is acquired for the whole callback, so all statements share a
 * consistent snapshot. The client is always released, including on a write
 * rejection or a query failure. Repositories are preferred; if no healthy
 * replica is available the primary is used, still in read-only mode.
 */
export async function withReadOnlyTransaction<T>(
  run: (client: ReadOnlyClient) => Promise<T>,
  options: ReadOnlyTransactionOptions = {},
): Promise<T> {
  const acquire = options.clientFactory ?? getReadClient;
  const client = await acquire();
  let transactionStarted = false;

  try {
    // A single statement starts the transaction in read-only mode, so no
    // write can slip in between BEGIN and the isolation setting.
    await client.query("BEGIN READ ONLY");
    transactionStarted = true;

    const guarded: ReadOnlyClient = {
      query: <T extends QueryResultRow = QueryResultRow>(
        text: string,
        params?: unknown[],
      ) => {
        if (!isReadOnlyQuery(text)) {
          const command = getQueryCommand(text);
          throw new BusinessLogicError(
            `Read-only transaction rejects ${command} statements`,
            ERROR_CODES.DATABASE_ERROR,
            { statement: command, operation: "read-only-transaction" },
          );
        }
        return client.query<T>(text, params as unknown[] | undefined);
      },
    };

    const result = await run(guarded);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logger.error("[read-only-client] ROLLBACK failed:", rollbackError);
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
