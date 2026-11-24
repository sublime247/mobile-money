const mockPoolQuery = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

import {
  getEventSyncCursor,
  setEventSyncCursor,
  getStaleEventSyncStreams,
  INITIAL_SYNC_CURSOR,
} from "../../src/database/eventSyncStateRepository";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getEventSyncCursor", () => {
  it("returns the persisted cursor for a known stream", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ stream_key: "escrow-events", cursor: "123456789", updated_at: new Date() }],
    });

    const cursor = await getEventSyncCursor("escrow-events");

    expect(cursor).toBe("123456789");
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE stream_key = $1"),
      ["escrow-events"],
    );
  });

  it("returns null when the stream has never synced", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const cursor = await getEventSyncCursor("contract-state-archiver");

    expect(cursor).toBeNull();
  });
});

describe("setEventSyncCursor", () => {
  it("upserts the cursor for a stream", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await setEventSyncCursor("escrow-events", "987654321");

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (stream_key)"),
      ["escrow-events", "987654321"],
    );
  });

  it("can be used to seed the initial cursor value", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await setEventSyncCursor("new-stream", INITIAL_SYNC_CURSOR);

    expect(mockPoolQuery).toHaveBeenCalledWith(expect.any(String), [
      "new-stream",
      "now",
    ]);
  });
});

describe("getStaleEventSyncStreams", () => {
  it("returns streams whose cursor hasn't advanced within the window", async () => {
    const staleRow = {
      stream_key: "contract-state-archiver",
      cursor: "111",
      updated_at: new Date("2026-08-01T00:00:00Z"),
    };
    mockPoolQuery.mockResolvedValueOnce({ rows: [staleRow] });

    const rows = await getStaleEventSyncStreams(30);

    expect(rows).toEqual([staleRow]);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE updated_at < NOW() - ($1 || ' minutes')::INTERVAL"),
      [30],
    );
  });

  it("orders results oldest-updated first", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await getStaleEventSyncStreams(60);

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY updated_at ASC"),
      [60],
    );
  });

  it("returns an empty array when every stream is healthy", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const rows = await getStaleEventSyncStreams(15);

    expect(rows).toEqual([]);
  });

  it("passes the staleMinutes threshold through as a query parameter", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await getStaleEventSyncStreams(120);

    expect(mockPoolQuery).toHaveBeenCalledWith(expect.any(String), [120]);
  });
});
