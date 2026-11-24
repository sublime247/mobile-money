import {
  computeClockOffset,
  secondsRemaining,
  startCountdown,
} from "../../frontend/components/quoteCountdown";

describe("SEP-38 quote countdown (#2039)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => jest.useRealTimers());

  it("computes seconds remaining and never goes negative", () => {
    const now = Date.now();
    expect(secondsRemaining(new Date(now + 30_000).toISOString())).toBe(30);
    expect(secondsRemaining(new Date(now - 5_000).toISOString())).toBe(0);
    expect(secondsRemaining("not-a-date")).toBe(0);
  });

  it("corrects for client clock drift using the server timestamp", () => {
    // Client clock is 20s ahead of the server.
    const serverTime = new Date(Date.now() - 20_000).toISOString();
    const offset = computeClockOffset(serverTime);
    expect(offset).toBe(-20_000);
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
    expect(secondsRemaining(expiresAt, 0)).toBe(10);
    expect(secondsRemaining(expiresAt, offset)).toBe(30);
    expect(computeClockOffset(undefined)).toBe(0);
  });

  it("ticks every second and fires onExpire exactly once", () => {
    const onTick = jest.fn();
    const onExpire = jest.fn();
    startCountdown({
      expiresAt: new Date(Date.now() + 3_000).toISOString(),
      onTick,
      onExpire,
    });
    expect(onTick).toHaveBeenLastCalledWith(3);

    jest.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenLastCalledWith(2);
    expect(onExpire).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2000);
    expect(onTick).toHaveBeenLastCalledWith(0);
    expect(onExpire).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(5000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("stop function cancels the timer", () => {
    const onTick = jest.fn();
    const stop = startCountdown({
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      onTick,
      onExpire: jest.fn(),
    });
    stop();
    onTick.mockClear();
    jest.advanceTimersByTime(3000);
    expect(onTick).not.toHaveBeenCalled();
  });
});
