import logger from "../utils/logger";
import { withRetry } from "./retry";

export const RECONCILIATION_DB_RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 250,
} as const;

export async function withReconciliationDbRetry<T>(
  operation: string,
  context: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  return withRetry(fn, {
    ...RECONCILIATION_DB_RETRY_OPTIONS,
    onRetry: ({ attempt, error }) => {
      logger.warn(
        {
          operation,
          attempt,
          ...context,
          error,
        },
        "Retrying reconciliation database operation after transient failure",
      );
    },
  });
}
