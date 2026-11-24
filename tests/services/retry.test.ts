import { isTransientError, withRetry } from "../../src/services/retry";

describe("retry service", () => {
  describe("isTransientError", () => {
    it("treats timeouts and network errors as transient", () => {
      expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true);
      expect(isTransientError(new Error("fetch failed"))).toBe(true);
      expect(isTransientError(new Error("503 Service Unavailable"))).toBe(true);
    });

    it("treats validation and business errors as permanent", () => {
      expect(isTransientError(new Error("Invalid phone number"))).toBe(false);
      expect(isTransientError(new Error("Insufficient funds"))).toBe(false);
      expect(isTransientError(new Error("Bad Request"))).toBe(false);
      expect(isTransientError(new Error("Wrong number timeout"))).toBe(false);
      expect(isTransientError(new Error("Bad request timeout"))).toBe(false);
    });

    it("treats retryable database lock and timeout errors as transient", () => {
      expect(
        isTransientError(
          Object.assign(new Error("deadlock detected"), { code: "40P01" }),
        ),
      ).toBe(true);
      expect(
        isTransientError(
          Object.assign(new Error("canceling statement due to lock timeout"), {
            code: "55P03",
          }),
        ),
      ).toBe(true);
      expect(
        isTransientError(
          Object.assign(new Error("canceling statement due to statement timeout"), {
            code: "57014",
          }),
        ),
      ).toBe(true);
      expect(
        isTransientError({
          originalError: Object.assign(new Error("could not obtain lock on row"), {
            code: "55P03",
          }),
        }),
      ).toBe(true);
    });
  });

  describe("withRetry", () => {
    it("succeeds on first attempt", async () => {
      const fn = jest.fn().mockResolvedValue(42);
      await expect(
        withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 }),
      ).resolves.toBe(42);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("allows a single attempt when maxAttempts is 1", async () => {
      const fn = jest.fn().mockResolvedValue("only-once");

      await expect(
        withRetry(fn, { maxAttempts: 1, baseDelayMs: 0 }),
      ).resolves.toBe("only-once");

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries transient errors with zero delay then succeeds", async () => {
      let calls = 0;
      const fn = jest.fn(async () => {
        calls++;
        if (calls < 3) throw new Error("ECONNRESET");
        return "ok";
      });
      const onRetry = jest.fn();
      await expect(
        withRetry(fn, { maxAttempts: 5, baseDelayMs: 0, onRetry }),
      ).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it("waits with exponential backoff between transient retries", async () => {
      jest.useFakeTimers();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      let calls = 0;
      const fn = jest.fn(async () => {
        calls++;
        if (calls < 3) {
          throw new Error("ETIMEDOUT");
        }
        return "ok";
      });

      const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });
      void promise.catch(() => undefined);

      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenNthCalledWith(
        1,
        "[retry] transient failure attempt 1/3, backing off",
        "ETIMEDOUT",
      );

      await jest.advanceTimersByTimeAsync(99);
      expect(fn).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenNthCalledWith(
        2,
        "[retry] transient failure attempt 2/3, backing off",
        "ETIMEDOUT",
      );

      await jest.advanceTimersByTimeAsync(199);
      expect(fn).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
    });

    it("does not retry permanent errors", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("Invalid amount"));
      const onRetry = jest.fn();
      await expect(
        withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, onRetry }),
      ).rejects.toThrow("Invalid amount");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it("throws when maxAttempts is less than 1", async () => {
      await expect(
        withRetry(jest.fn(), { maxAttempts: 0, baseDelayMs: 0 }),
      ).rejects.toThrow("maxAttempts must be at least 1");
    });

    it("throws after exhausting attempts on transient errors", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("socket hang up"));
      await expect(
        withRetry(fn, { maxAttempts: 2, baseDelayMs: 0 }),
      ).rejects.toThrow("socket hang up");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("does not retry transient errors when the first attempt is also the last", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("socket hang up"));
      const onRetry = jest.fn();

      await expect(
        withRetry(fn, { maxAttempts: 1, baseDelayMs: 0, onRetry }),
      ).rejects.toThrow("socket hang up");

      expect(fn).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it("calls onRetry with the failed attempt metadata", async () => {
      let calls = 0;
      const fn = jest.fn(async () => {
        calls++;
        if (calls === 1) {
          throw new Error("503 Service Unavailable");
        }
        return "ok";
      });
      const onRetry = jest.fn();

      await expect(
        withRetry(fn, { maxAttempts: 2, baseDelayMs: 0, onRetry }),
      ).resolves.toBe("ok");

      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          error: expect.any(Error),
        }),
      );
    });

    it("retries retryable database lock errors and eventually succeeds", async () => {
      let calls = 0;
      const fn = jest.fn(async () => {
        calls++;
        if (calls < 3) {
          throw Object.assign(new Error("canceling statement due to lock timeout"), {
            code: "55P03",
          });
        }
        return "ok";
      });

      await expect(
        withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 }),
      ).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });
});
