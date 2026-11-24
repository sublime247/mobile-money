import { WebhookService, WebhookOutboxEntry, WebhookOutboxModel } from "../webhook";

function makeEntry(overrides: Partial<WebhookOutboxEntry> = {}): WebhookOutboxEntry {
  return {
    id: "entry-1",
    eventType: "deposit.completed",
    payload: {
      event_id: "evt-1",
      event_type: "deposit.completed",
      timestamp: new Date().toISOString(),
      transaction_id: "txn-1",
      reference_number: "REF-1",
      transaction_type: "deposit",
      amount: "100.00",
      currency: "XOF",
      phone_number: "+2250701020304",
      provider: "moov",
      stellar_address: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
      status: "completed",
      created_at: new Date().toISOString(),
    },
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeOutboxModel(entries: WebhookOutboxEntry[]): jest.Mocked<WebhookOutboxModel> {
  return {
    insert: jest.fn(),
    findNextToProcess: jest.fn().mockResolvedValue(entries),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn(),
  };
}

describe("WebhookService.processOutbox", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("delivers each entry and marks it delivered on success", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const service = new WebhookService({
      fetchImpl: mockFetch,
      webhookUrl: "https://example.com/webhooks",
      webhookSecret: "test-secret",
    });
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b" })];
    const outboxModel = makeOutboxModel(entries);

    const result = await service.processOutbox(outboxModel, 10);

    expect(result).toEqual({ processed: 2, failures: 0 });
    expect(outboxModel.update).toHaveBeenCalledWith(
      "a",
      expect.objectContaining({ status: "delivered" }),
    );
    expect(outboxModel.update).toHaveBeenCalledWith(
      "b",
      expect.objectContaining({ status: "delivered" }),
    );
  });

  it("aborts a hung entry after timeoutMs instead of blocking the batch indefinitely", async () => {
    // First entry never resolves (simulates a connection accepted but never
    // responded to); it must respect the AbortSignal passed to fetchImpl.
    // Second entry resolves immediately and must still be processed.
    const mockFetch = jest.fn().mockImplementation((_url, init) => {
      return new Promise((resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
        // never resolves on its own for the hung entry
      });
    });

    const service = new WebhookService({
      fetchImpl: mockFetch,
      webhookUrl: "https://example.com/webhooks",
      webhookSecret: "test-secret",
      timeoutMs: 1_000,
      maxAttempts: 1,
    });

    const hungEntry = makeEntry({ id: "hung" });
    const outboxModel = makeOutboxModel([hungEntry]);

    const processPromise = service.processOutbox(outboxModel, 10);

    // Advance past the timeout so the AbortController fires.
    await jest.advanceTimersByTimeAsync(1_000);

    const result = await processPromise;

    expect(result).toEqual({ processed: 0, failures: 1 });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/webhooks",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(outboxModel.update).toHaveBeenCalledWith(
      "hung",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("continues processing later entries after an earlier one times out", async () => {
    let callCount = 0;
    const mockFetch = jest.fn().mockImplementation((_url, init) => {
      callCount++;
      if (callCount === 1) {
        // First call: hangs until aborted.
        return new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      }
      // Subsequent calls resolve immediately.
      return Promise.resolve({ ok: true, status: 200 });
    });

    const service = new WebhookService({
      fetchImpl: mockFetch,
      webhookUrl: "https://example.com/webhooks",
      webhookSecret: "test-secret",
      timeoutMs: 1_000,
      maxAttempts: 1,
    });

    const entries = [makeEntry({ id: "hung" }), makeEntry({ id: "healthy" })];
    const outboxModel = makeOutboxModel(entries);

    const processPromise = service.processOutbox(outboxModel, 10);
    await jest.advanceTimersByTimeAsync(1_000);
    const result = await processPromise;

    expect(result).toEqual({ processed: 1, failures: 1 });
    expect(outboxModel.update).toHaveBeenCalledWith(
      "healthy",
      expect.objectContaining({ status: "delivered" }),
    );
  });
});
