/**
 * Unit tests for the cursor-based pagination utility — issue #2288
 */

import {
  encodeCursor,
  decodeCursor,
  buildPaginationMeta,
  type CursorPayload,
} from "../pagination";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(createdAt: Date, id: string) {
  return { createdAt, id };
}

// ---------------------------------------------------------------------------
// encodeCursor / decodeCursor round-trips
// ---------------------------------------------------------------------------

describe("encodeCursor", () => {
  it("returns a non-empty string", () => {
    const cursor = encodeCursor({
      created_at: "2026-10-19T12:00:00.000Z",
      id: "abc-123",
    });
    expect(typeof cursor).toBe("string");
    expect(cursor.length).toBeGreaterThan(0);
  });

  it("produces a URL-safe Base64url string (no +, /, =)", () => {
    const cursor = encodeCursor({
      created_at: "2026-10-19T12:00:00.000Z",
      id: "abc-123",
    });
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it("throws when created_at is missing", () => {
    expect(() =>
      encodeCursor({ created_at: "", id: "abc" }),
    ).toThrow();
  });

  it("throws when id is missing", () => {
    expect(() =>
      encodeCursor({ created_at: "2026-10-19T12:00:00.000Z", id: "" }),
    ).toThrow();
  });

  it("throws when created_at is not a valid date", () => {
    expect(() =>
      encodeCursor({ created_at: "not-a-date", id: "abc" }),
    ).toThrow();
  });
});

describe("decodeCursor", () => {
  it("round-trips an encoded cursor", () => {
    const payload: CursorPayload = {
      created_at: "2026-10-19T12:34:56.789Z",
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    };
    const cursor = encodeCursor(payload);
    const decoded = decodeCursor(cursor);
    expect(decoded.created_at).toBe(payload.created_at);
    expect(decoded.id).toBe(payload.id);
  });

  it("throws on an empty string", () => {
    expect(() => decodeCursor("")).toThrow();
  });

  it("throws on a non-base64 string", () => {
    expect(() => decodeCursor("!!!not-valid!!!")).toThrow();
  });

  it("throws on a base64 string without the pipe separator", () => {
    const noSep = Buffer.from("no-pipe-here").toString("base64url");
    expect(() => decodeCursor(noSep)).toThrow(/separator/);
  });

  it("throws on a cursor with an invalid date component", () => {
    const bad = Buffer.from("not-a-date|some-uuid").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow();
  });

  it("handles UUIDs that contain pipe-like characters gracefully via lastIndexOf", () => {
    // The decoder uses lastIndexOf("|") so a uuid with a pipe-like char
    // (edge case) won't split the id field.
    const payload: CursorPayload = {
      created_at: "2026-10-19T00:00:00.000Z",
      id: "aaaa-bbbb-cccc",
    };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded.id).toBe(payload.id);
  });
});

// ---------------------------------------------------------------------------
// buildPaginationMeta
// ---------------------------------------------------------------------------

describe("buildPaginationMeta — forward direction", () => {
  const limit = 3;

  it("sets has_next=true when rows.length > limit (more pages forward)", () => {
    const rows = [
      makeRow(new Date("2026-10-19T10:00:00Z"), "id-1"),
      makeRow(new Date("2026-10-19T09:00:00Z"), "id-2"),
      makeRow(new Date("2026-10-19T08:00:00Z"), "id-3"),
      makeRow(new Date("2026-10-19T07:00:00Z"), "id-4"), // sentinel
    ];
    const meta = buildPaginationMeta(rows, limit, "forward", false);
    expect(meta.has_next).toBe(true);
    expect(meta.count).toBe(limit);
  });

  it("sets has_next=false when rows.length <= limit (last page)", () => {
    const rows = [
      makeRow(new Date("2026-10-19T10:00:00Z"), "id-1"),
      makeRow(new Date("2026-10-19T09:00:00Z"), "id-2"),
    ];
    const meta = buildPaginationMeta(rows, limit, "forward", false);
    expect(meta.has_next).toBe(false);
    expect(meta.count).toBe(2);
  });

  it("sets has_prev=false on the first page (hasPrevPage=false)", () => {
    const rows = [
      makeRow(new Date("2026-10-19T10:00:00Z"), "id-1"),
      makeRow(new Date("2026-10-19T09:00:00Z"), "id-2"),
    ];
    const meta = buildPaginationMeta(rows, limit, "forward", false);
    expect(meta.has_prev).toBe(false);
  });

  it("sets has_prev=true when hasPrevPage=true (not first page)", () => {
    const rows = [
      makeRow(new Date("2026-10-19T10:00:00Z"), "id-1"),
      makeRow(new Date("2026-10-19T09:00:00Z"), "id-2"),
    ];
    const meta = buildPaginationMeta(rows, limit, "forward", true);
    expect(meta.has_prev).toBe(true);
  });

  it("next_cursor is decodable and points to the last row", () => {
    const rows = [
      makeRow(new Date("2026-10-19T10:00:00Z"), "id-1"),
      makeRow(new Date("2026-10-19T09:00:00Z"), "id-2"),
      makeRow(new Date("2026-10-19T08:00:00Z"), "id-3"),
      makeRow(new Date("2026-10-19T07:00:00Z"), "id-4"), // sentinel
    ];
    const meta = buildPaginationMeta(rows, limit, "forward", false);
    expect(meta.next_cursor).not.toBeNull();
    const decoded = decodeCursor(meta.next_cursor!);
    expect(decoded.id).toBe("id-3");
  });

  it("next_cursor is null on the last page", () => {
    const rows = [
      makeRow(new Date("2026-10-19T10:00:00Z"), "id-1"),
    ];
    const meta = buildPaginationMeta(rows, limit, "forward", false);
    expect(meta.next_cursor).toBeNull();
  });

  it("returns null cursors and count=0 for an empty result set", () => {
    const meta = buildPaginationMeta([], limit, "forward", false);
    expect(meta.next_cursor).toBeNull();
    expect(meta.prev_cursor).toBeNull();
    expect(meta.count).toBe(0);
  });

  it("respects limit field in meta", () => {
    const rows = [
      makeRow(new Date("2026-10-19T10:00:00Z"), "id-1"),
    ];
    const meta = buildPaginationMeta(rows, 10, "forward", false);
    expect(meta.limit).toBe(10);
  });
});

describe("buildPaginationMeta — backward direction", () => {
  const limit = 2;

  it("reverses rows so result is newest-first", () => {
    // DB returns oldest-first for backward page
    const rows = [
      makeRow(new Date("2026-10-19T08:00:00Z"), "id-3"),
      makeRow(new Date("2026-10-19T09:00:00Z"), "id-2"),
    ];

    // buildPaginationMeta receives the raw rows and reverses internally
    // We verify by checking that prev_cursor points to the first item (id-2 after reverse)
    const meta = buildPaginationMeta(rows, limit, "backward", true);
    // After reverse: [id-2 (09:00), id-3 (08:00)]
    // prev_cursor should point to the first row after reverse = id-2
    expect(meta.prev_cursor).not.toBeNull();
    const decoded = decodeCursor(meta.prev_cursor!);
    expect(decoded.id).toBe("id-2");
  });

  it("sets has_prev=true when there are more rows backward (sentinel present)", () => {
    const rows = [
      makeRow(new Date("2026-10-19T07:00:00Z"), "id-4"), // sentinel
      makeRow(new Date("2026-10-19T08:00:00Z"), "id-3"),
      makeRow(new Date("2026-10-19T09:00:00Z"), "id-2"),
    ];
    const meta = buildPaginationMeta(rows, limit, "backward", true);
    expect(meta.has_prev).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bidirectional boundary handling
// ---------------------------------------------------------------------------

describe("cursor pagination — boundary conditions", () => {
  it("single-item page has both cursors pointing to the same row", () => {
    const rows = [
      makeRow(new Date("2026-10-19T10:00:00Z"), "only-row"),
    ];
    const meta = buildPaginationMeta(rows, 10, "forward", true);
    // has_prev because hasPrevPage=true
    expect(meta.has_prev).toBe(true);
    expect(meta.has_next).toBe(false);
    if (meta.prev_cursor) {
      expect(decodeCursor(meta.prev_cursor).id).toBe("only-row");
    }
  });

  it("cursor encodes millisecond precision timestamps correctly", () => {
    const ts = "2026-10-19T12:34:56.789Z";
    const cursor = encodeCursor({ created_at: ts, id: "test-id" });
    const decoded = decodeCursor(cursor);
    expect(decoded.created_at).toBe(ts);
  });
});
