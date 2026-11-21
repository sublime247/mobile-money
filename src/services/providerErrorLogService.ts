/**
 * Persistence for failed provider API call snapshots (#2445).
 *
 * Snapshots are sanitized (PII / credential masking) and size-capped by
 * src/utils/payloadSanitizer.ts before they reach this module. Rows live in
 * `provider_error_logs` for {@link PROVIDER_ERROR_LOG_RETENTION_DAYS} days and
 * are removed by {@link purgeExpiredProviderErrorLogs}, run daily from
 * src/jobs/scheduler.ts.
 */
import { queryWrite } from "../config/database";
import logger from "../utils/logger";

export const PROVIDER_ERROR_LOG_RETENTION_DAYS = 30;

export interface ProviderErrorSnapshot {
  provider: string;
  method?: string;
  url?: string;
  statusCode?: number;
  errorCode?: string;
  errorMessage?: string;
  requestHeaders?: unknown;
  requestBody?: unknown;
  responseHeaders?: unknown;
  responseBody?: unknown;
  payloadTruncated: boolean;
  durationMs?: number;
  correlationId?: string;
}

/** JSONB columns need a JSON value; plain strings are wrapped as JSON strings. */
function toJsonb(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/**
 * Insert one snapshot. Never throws: logging a provider failure must not turn
 * into a second failure for the caller.
 */
export async function recordProviderErrorLog(
  snapshot: ProviderErrorSnapshot,
): Promise<void> {
  try {
    await queryWrite(
      `INSERT INTO provider_error_logs (
         provider, method, url, status_code, error_code, error_message,
         request_headers, request_body, response_headers, response_body,
         payload_truncated, duration_ms, correlation_id, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
         $11, $12, $13, NOW() + ($14 || ' days')::interval
       )`,
      [
        snapshot.provider,
        snapshot.method ?? null,
        snapshot.url ?? null,
        snapshot.statusCode ?? null,
        snapshot.errorCode ?? null,
        snapshot.errorMessage ?? null,
        toJsonb(snapshot.requestHeaders),
        toJsonb(snapshot.requestBody),
        toJsonb(snapshot.responseHeaders),
        toJsonb(snapshot.responseBody),
        snapshot.payloadTruncated,
        snapshot.durationMs ?? null,
        snapshot.correlationId ?? null,
        String(PROVIDER_ERROR_LOG_RETENTION_DAYS),
      ],
    );
  } catch (err) {
    logger.warn(
      {
        provider: snapshot.provider,
        error: err instanceof Error ? err.message : String(err),
      },
      "[provider-error-log] Failed to persist provider error snapshot",
    );
  }
}

/** Delete snapshots past their 30-day retention. Returns the number removed. */
export async function purgeExpiredProviderErrorLogs(): Promise<number> {
  const result = await queryWrite(
    `DELETE FROM provider_error_logs
      WHERE expires_at < NOW()
         OR created_at < NOW() - ($1 || ' days')::interval`,
    [String(PROVIDER_ERROR_LOG_RETENTION_DAYS)],
  );
  const removed = result.rowCount ?? 0;
  logger.info(
    { removed },
    `[provider-error-log] Purged ${removed} provider error snapshots older than ${PROVIDER_ERROR_LOG_RETENTION_DAYS} days`,
  );
  return removed;
}
