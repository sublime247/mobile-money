import {
  computeFullJitterDelayMs,
  isRetryableGatewayError,
  retryWithJitter,
} from "../retryWithJitter";

function gatewayError(status: number) {
  return Object.assign(new Error(`upstream responded ${status}`), {
    response: { status },
  });
}

function clientError(status: number) {
  return Object.assign(new Error(`rejected with ${status}`), {
    response: { status },
  });
}

describe("isRetryableGatewayError (#2367)", () => {
  it.each([502, 503, 504])("treats HTTP %d as retryable", (status) => {
    expect(isRetryableGatewayError(gatewayError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])(
    "treats HTTP %d as non-retryable",
    (status) => {
      expect(isRetryableGatewayError(clientError(status))).toBe(false);
    },
  );

  it("treats a 500 as non-retryable (only 502/503/504 are transient gateway errors here)", () => {
    expect(isRetryableGatewayError(clientError(500))).toBe(false);
  });

  it.each(["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED"])(
    "treats network error code %s as retryable",
    (code) => {
      expect(
        isRetryableGatewayError(Object.assign(new Error("boom"), { code })),
      ).toBe(true);
    },
  );

  it("treats a message mentioning timeout as retryable even without a code", () => {
    expect(isRetryableGatewayError(new Error("request timeout exceeded"))).toBe(
      true,
    );
  });

  it("treats an unrelated error as non-retryable", () => {
    expect(isRetryableGatewayError(new Error("invalid phone number"))).toBe(
      false,
    );
  });

  it("treats a non-Error, non-object value as non-retryable", () => {
    expect(isRetryableGatewayError("just a string")).toBe(false);
    expect(isRetryableGatewayError(null)).toBe(false);
    expect(isRetryableGatewayError(undefined)).toBe(false);
  });
});

describe("computeFullJitterDelayMs (#2367)", () => {
  it("draws uniformly from [0, cap] where cap = min(maxBackoffMs, baseDelayMs * multiplier^attempt)", () => {
    // attempt 0: cap = 500 * 2^0 = 500
    expect(
      computeFullJitterDelayMs(0, { random: () => 0 }),
    ).toBe(0);
    expect(
      computeFullJitterDelayMs(0, { random: () => 0.999999 }),
    ).toBeLessThan(500);

    // attempt 1: cap = 500 * 2^1 = 1000
    expect(
      computeFullJitterDelayMs(1, { random: () => 0.5 }),
    ).toBe(500);

    // attempt 2: cap = 500 * 2^2 = 2000
    expect(
      computeFullJitterDelayMs(2, { random: () => 0.5 }),
    ).toBe(1000);
  });

  it("caps the exponential growth at maxBackoffMs", () => {
    // attempt 10: uncapped exponential would be 500 * 2^10 = 512000,
    // but maxBackoffMs caps it at 10000.
    const delay = computeFullJitterDelayMs(10, { random: () => 0.999999 });
    expect(delay).toBeLessThan(10_000);
    expect(delay).toBeGreaterThan(9_000);
  });

  it("respects custom baseDelayMs, multiplier, and maxBackoffMs", () => {
    const delay = computeFullJitterDelayMs(1, {
      baseDelayMs: 100,
      multiplier: 3,
      maxBackoffMs: 50_000,
      random: () => 1,
    });
    // cap = 100 * 3^1 = 300; random() = 1 -> Math.floor(1 * 300) = 300
    expect(delay).toBe(300);
  });
});

describe("retryWithJitter (#2367)", () => {
  function noopSleep() {
    return Promise.resolve();
  }

  it("returns the result immediately on success without retrying", async () => {
    const fn = jest.fn().mockResolvedValue("ok");

    const result = await retryWithJitter(fn, { sleep: noopSleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 504 up to maxRetries times, then succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(gatewayError(504))
      .mockRejectedValueOnce(gatewayError(502))
      .mockResolvedValueOnce("recovered");

    const result = await retryWithJitter(fn, {
      sleep: noopSleep,
      random: () => 0,
    });

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-transient 4xx error", async () => {
    const fn = jest.fn().mockRejectedValue(clientError(400));

    await expect(
      retryWithJitter(fn, { sleep: noopSleep }),
    ).rejects.toThrow("rejected with 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries transient failures and rethrows the last error", async () => {
    const fn = jest.fn().mockRejectedValue(gatewayError(503));

    await expect(
      retryWithJitter(fn, { maxRetries: 3, sleep: noopSleep, random: () => 0 }),
    ).rejects.toThrow("upstream responded 503");
    // Initial attempt + 3 retries = 4 calls total.
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("respects a custom maxRetries of 0 (no retries at all)", async () => {
    const fn = jest.fn().mockRejectedValue(gatewayError(502));

    await expect(
      retryWithJitter(fn, { maxRetries: 0, sleep: noopSleep }),
    ).rejects.toThrow("upstream responded 502");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rejects a negative maxRetries", async () => {
    const fn = jest.fn();

    await expect(
      retryWithJitter(fn, { maxRetries: -1, sleep: noopSleep }),
    ).rejects.toThrow(/maxRetries/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("invokes onRetry with the attempt number, computed delay, and error before each retry", async () => {
    const onRetry = jest.fn().mockResolvedValue(undefined);
    const fn = jest
      .fn()
      .mockRejectedValueOnce(gatewayError(504))
      .mockResolvedValueOnce("ok");

    await retryWithJitter(fn, {
      sleep: noopSleep,
      random: () => 0.5,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    const info = onRetry.mock.calls[0][0];
    expect(info.attempt).toBe(1);
    expect(typeof info.delayMs).toBe("number");
    expect(info.error).toBeInstanceOf(Error);
  });

  it("sleeps for the computed delay between retries", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest
      .fn()
      .mockRejectedValueOnce(gatewayError(504))
      .mockResolvedValueOnce("ok");

    await retryWithJitter(fn, { sleep, random: () => 0.5 });

    expect(sleep).toHaveBeenCalledTimes(1);
    // attempt 0 cap = 500 * 2^0 = 500; random 0.5 -> 250ms.
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("uses a custom isRetryable predicate instead of the gateway-error default", async () => {
    class DomainError extends Error {}
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new DomainError("retry me"))
      .mockResolvedValueOnce("ok");

    const result = await retryWithJitter(fn, {
      sleep: noopSleep,
      isRetryable: (error) => error instanceof DomainError,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
