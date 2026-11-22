import {
  CALLBACK_RETRY_SCHEDULE_MS,
  getCallbackBackoffDelay,
  enqueueCallbackRetry,
  callbackQueue,
} from "../../src/queue/callbackQueue";

jest.mock("../../src/queue/config", () => ({
  queueOptions: {
    connection: { host: "localhost", port: 6379 },
  },
}));

describe("SEP-24 Callback Retry Queue (#2124)", () => {
  describe("Backoff Schedule", () => {
    it("should define 5 backoff steps: 10s, 30s, 2m, 10m, 30m", () => {
      expect(CALLBACK_RETRY_SCHEDULE_MS).toEqual([
        10_000,
        30_000,
        120_000,
        600_000,
        1_800_000,
      ]);
    });

    it("should compute delay with jitter for each attempt", () => {
      // Attempt 1: ~10s
      const delay1 = getCallbackBackoffDelay(1);
      expect(delay1).toBeGreaterThanOrEqual(10_000);
      expect(delay1).toBeLessThanOrEqual(11_000);

      // Attempt 2: ~30s
      const delay2 = getCallbackBackoffDelay(2);
      expect(delay2).toBeGreaterThanOrEqual(30_000);
      expect(delay2).toBeLessThanOrEqual(33_000);

      // Attempt 3: ~2m
      const delay3 = getCallbackBackoffDelay(3);
      expect(delay3).toBeGreaterThanOrEqual(120_000);
      expect(delay3).toBeLessThanOrEqual(132_000);

      // Attempt 4: ~10m
      const delay4 = getCallbackBackoffDelay(4);
      expect(delay4).toBeGreaterThanOrEqual(600_000);
      expect(delay4).toBeLessThanOrEqual(660_000);

      // Attempt 5: ~30m
      const delay5 = getCallbackBackoffDelay(5);
      expect(delay5).toBeGreaterThanOrEqual(1_800_000);
      expect(delay5).toBeLessThanOrEqual(1_980_000);
    });

    it("should clamp higher attempt numbers to maximum backoff delay", () => {
      const delay = getCallbackBackoffDelay(10);
      expect(delay).toBeGreaterThanOrEqual(1_800_000);
      expect(delay).toBeLessThanOrEqual(1_980_000);
    });
  });

  describe("enqueueCallbackRetry", () => {
    it("should add job to BullMQ queue with 5 attempts and custom backoff", async () => {
      const addSpy = jest
        .spyOn(callbackQueue, "add")
        .mockResolvedValue({ id: "job-1" } as any);

      await enqueueCallbackRetry({
        transactionId: "tx-123",
        status: "completed",
        callbackUrl: "https://wallet.example.com/callback",
        payload: { id: "tx-123", status: "completed" },
      });

      expect(addSpy).toHaveBeenCalledWith(
        "deliver-callback",
        expect.objectContaining({
          transactionId: "tx-123",
          status: "completed",
          callbackUrl: "https://wallet.example.com/callback",
        }),
        expect.objectContaining({
          attempts: 5,
          backoff: { type: "sep24ExponentialJitter" },
        }),
      );

      addSpy.mockRestore();
    });
  });
});
