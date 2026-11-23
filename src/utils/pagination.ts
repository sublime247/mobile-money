/**
 * Cursor-based pagination utility — issue #2288
 *
 * Encodes / decodes opaque cursor tokens used by the transaction audit-log
 * listing endpoint.  Each cursor encodes the two fields that the index-backed
 * keyset WHERE clause requires:
 *
 *   cursor  →  (created_at ISO-8601, id UUID)
 *
 * The cursor is Base64url-encoded so it is URL-safe without further percent-
 * encoding and is opaque to API consumers (they must not parse it).
 *
 * SQL keyset patterns:
 *
 *   Forwards  (after cursor):
 *     WHERE (created_at, id) < (:cursor_created_at, :cursor_id)
 *     ORDER BY created_at DESC, id DESC
 *
 *   Backwards (before cursor):
 *     WHERE (created_at, id) > (:cursor_created_at, :cursor_id)
 *     ORDER BY created_at ASC, id ASC
 *     -- then reverse the result set in application code
 *
 * This pattern uses idx_transactions_status_created_id (or the equivalent
 * covering index) for constant-time page retrieval regardless of depth.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CursorPayload {
  /** ISO-8601 string (e.g. "2026-10-19T12:34:56.789Z") */
  created_at: string;
  /** UUID of the row */
  id: string;
}

export interface PaginationMeta {
  /** Opaque token — pass as `?after=` to fetch the next page. */
  next_cursor: string | null;
  /** Opaque token — pass as `?before=` to fetch the previous page. */
  prev_cursor: string | null;
  /** Whether there are more records in the forward direction. */
  has_next: boolean;
  /** Whether there are more records in the backward direction. */
  has_prev: boolean;
  /** Number of records returned on this page. */
  count: number;
  /** The limit that was requested. */
  limit: number;
}

export interface CursorPaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/**
 * Encode a `(created_at, id)` pair into an opaque Base64url cursor string.
 *
 * @throws {Error} if `created_at` is not a valid ISO-8601 date string.
 */
export function encodeCursor(payload: CursorPayload): string {
  if (!payload.created_at || !payload.id) {
    throw new Error("encodeCursor: created_at and id are required");
  }
  // Validate the date
  if (Number.isNaN(new Date(payload.created_at).getTime())) {
    throw new Error(
      `encodeCursor: invalid created_at value "${payload.created_at}"`,
    );
  }

  const raw = `${payload.created_at}|${payload.id}`;
  // Base64url (RFC 4648 §5) — no padding, URL-safe alphabet
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode a Base64url cursor string back into a `(created_at, id)` pair.
 *
 * @throws {Error} if the cursor is malformed or contains an invalid date.
 */
export function decodeCursor(cursor: string): CursorPayload {
  if (!cursor || typeof cursor !== "string") {
    throw new Error("decodeCursor: cursor must be a non-empty string");
  }

  // Re-add Base64 padding
  const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const base64 = padded + "=".repeat(padLength);

  let raw: string;
  try {
    raw = Buffer.from(base64, "base64").toString("utf8");
  } catch {
    throw new Error("decodeCursor: cursor is not valid base64");
  }

  const separatorIdx = raw.lastIndexOf("|");
  if (separatorIdx === -1) {
    throw new Error("decodeCursor: malformed cursor — missing separator");
  }

  const created_at = raw.slice(0, separatorIdx);
  const id = raw.slice(separatorIdx + 1);

  if (!created_at || !id) {
    throw new Error("decodeCursor: malformed cursor — empty fields");
  }

  const ts = new Date(created_at);
  if (Number.isNaN(ts.getTime())) {
    throw new Error(
      `decodeCursor: invalid created_at value in cursor "${created_at}"`,
    );
  }

  return { created_at, id };
}

// ---------------------------------------------------------------------------
// Build pagination metadata from a result set
// ---------------------------------------------------------------------------

/**
 * Build the `PaginationMeta` block from a raw result set fetched with a
 * limit+1 over-fetch strategy.
 *
 * @param rows        Raw rows from the DB query (may contain limit+1 items).
 * @param limit       The requested page size.
 * @param direction   "forward" (after) or "backward" (before).
 * @param hasPrevPage Whether a previous page exists (pass `true` when `after`
 *                    cursor was supplied, meaning we didn't start from the top).
 *
 * The function mutates `rows` by slicing it to `limit` items.
 */
export function buildPaginationMeta<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
  direction: "forward" | "backward",
  hasPrevPage: boolean,
): PaginationMeta {
  const hasMore = rows.length > limit;

  // Trim the sentinel row used to detect hasMore
  const trimmed = rows.slice(0, limit);

  // For backward pagination the DB returns rows oldest-first; reverse so the
  // API always returns newest-first regardless of direction.
  if (direction === "backward") {
    trimmed.reverse();
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];

  const prev_cursor =
    first && (hasPrevPage || direction === "backward" && hasMore)
      ? encodeCursor({
          created_at: first.createdAt.toISOString(),
          id: first.id,
        })
      : null;

  const next_cursor =
    last && (direction === "forward" ? hasMore : hasPrevPage)
      ? encodeCursor({
          created_at: last.createdAt.toISOString(),
          id: last.id,
        })
      : null;

  return {
    next_cursor,
    prev_cursor,
    has_next: direction === "forward" ? hasMore : hasPrevPage,
    has_prev:
      direction === "backward" ? hasMore : hasPrevPage,
    count: trimmed.length,
    limit,
  };
}
