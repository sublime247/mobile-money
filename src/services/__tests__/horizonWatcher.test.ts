import {
  HorizonWatcher,
  MemoryCursorStore,
  type CursorStore,
} from "../horizonWatcher";

describe("HorizonWatcher", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("loads persisted cursor from cursorStore on start", async () => {
    const store = new MemoryCursorStore();
    await store.set("test-stream", "123456789-0");

    let requestedCursor = "";
    const mockHorizon = {
      transactions: () => ({
        cursor: (c: string) => {
          requestedCursor = c;
          return {
            stream: ({ onmessage }: any) => () => {},
          };
        },
      }),
    };

    const watcher = new HorizonWatcher({
      streamKey: "test-stream",
      cursorStore: store,
      horizon: mockHorizon,
      enableCatchup: false,
    });

    await watcher.start();

    expect(requestedCursor).toBe("123456789-0");
    expect(watcher.getCurrentCursor()).toBe("123456789-0");
    expect(watcher.getStatus()).toBe("streaming");
    watcher.stop();
  });

  it("updates cursor checkpoint in store upon receiving transactions", async () => {
    const store = new MemoryCursorStore();
    let streamCallbacks: any = null;

    const mockHorizon = {
      transactions: () => ({
        cursor: () => ({
          stream: (callbacks: any) => {
            streamCallbacks = callbacks;
            return () => {};
          },
        }),
      }),
    };

    const processed: any[] = [];
    const watcher = new HorizonWatcher({
      streamKey: "test-stream",
      cursorStore: store,
      horizon: mockHorizon,
      enableCatchup: false,
      onTransaction: (tx) => {
        processed.push(tx);
      },
    });

    await watcher.start();

    // Emit transaction via SSE callback
    const testTx = {
      id: "tx-1",
      paging_token: "999999-1",
      hash: "abc123hash",
    };
    await streamCallbacks.onmessage(testTx);

    expect(processed).toHaveLength(1);
    expect(processed[0].id).toBe("tx-1");
    expect(watcher.getCurrentCursor()).toBe("999999-1");

    const savedCursor = await store.get("test-stream");
    expect(savedCursor).toBe("999999-1");

    watcher.stop();
  });

  it("handles stream disconnect and reconnects with exponential backoff", async () => {
    const store = new MemoryCursorStore();
    let connectCount = 0;
    let streamCallbacks: any = null;

    const mockHorizon = {
      transactions: () => ({
        cursor: () => ({
          stream: (callbacks: any) => {
            connectCount++;
            streamCallbacks = callbacks;
            return () => {};
          },
        }),
      }),
    };

    const statusChanges: string[] = [];
    const watcher = new HorizonWatcher({
      streamKey: "test-stream",
      cursorStore: store,
      horizon: mockHorizon,
      initialBackoffMs: 1000,
      maxBackoffMs: 10000,
      backoffFactor: 2,
      jitterRatio: 0,
      enableCatchup: false,
      onStatusChange: (status) => statusChanges.push(status),
    });

    await watcher.start();
    expect(connectCount).toBe(1);
    expect(watcher.getStatus()).toBe("streaming");

    // Simulate stream error / disconnect
    streamCallbacks.onerror(new Error("Connection reset by peer"));

    expect(watcher.getStatus()).toBe("reconnecting");
    expect(statusChanges).toContain("reconnecting");

    // Fast-forward backoff time (1000ms)
    jest.advanceTimersByTime(1100);

    expect(connectCount).toBe(2);
    expect(watcher.getStatus()).toBe("streaming");

    watcher.stop();
    expect(watcher.getStatus()).toBe("stopped");
  });

  it("catches up missed transactions during downtime before streaming", async () => {
    const store = new MemoryCursorStore();
    await store.set("test-stream", "1000");

    const missedTxs = [
      { id: "tx-downtime-1", paging_token: "1001" },
      { id: "tx-downtime-2", paging_token: "1002" },
    ];

    let pagedCalls = 0;
    const mockHorizon = {
      transactions: () => ({
        cursor: (c: string) => ({
          order: () => ({
            limit: () => ({
              call: async () => {
                pagedCalls++;
                return { records: missedTxs };
              },
            }),
          }),
          stream: () => () => {},
        }),
      }),
    };

    const received: string[] = [];
    const watcher = new HorizonWatcher({
      streamKey: "test-stream",
      cursorStore: store,
      horizon: mockHorizon,
      enableCatchup: true,
      onTransaction: (tx) => {
        received.push(tx.id);
      },
    });

    // Manually run catch-up simulation
    const paged = await watcher.catchupMissedTransactions();

    expect(paged).toBe(2);
    expect(received).toEqual(["tx-downtime-1", "tx-downtime-2"]);
    expect(watcher.getCurrentCursor()).toBe("1002");
    expect(await store.get("test-stream")).toBe("1002");
  });

  it("calculates exponential backoff with configured parameters", () => {
    const watcher = new HorizonWatcher({
      streamKey: "test",
      initialBackoffMs: 500,
      maxBackoffMs: 8000,
      backoffFactor: 2,
      jitterRatio: 0,
    });

    expect(watcher.calculateBackoff(0)).toBe(500);
    expect(watcher.calculateBackoff(1)).toBe(1000);
    expect(watcher.calculateBackoff(2)).toBe(2000);
    expect(watcher.calculateBackoff(3)).toBe(4000);
    expect(watcher.calculateBackoff(4)).toBe(8000);
    expect(watcher.calculateBackoff(5)).toBe(8000); // capped at maxBackoffMs
  });
});
