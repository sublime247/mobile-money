import {
  getPoolStatistics,
  PoolCountsSource,
  PoolStarvationMonitor,
} from "../../src/middleware/dbConnectionLeakDetector";
import { register } from "../../src/utils/metrics";

jest.mock("../../src/utils/logger");

/** Simulated pg.Pool whose counts tests move to model exhaustion. */
function fakePool(overrides: Partial<PoolCountsSource> = {}): PoolCountsSource {
  return {
    totalCount: 10,
    idleCount: 10,
    waitingCount: 0,
    options: { max: 10 },
    ...overrides,
  };
}

function exhaust(pool: PoolCountsSource, waiting: number): void {
  pool.idleCount = 0;
  pool.totalCount = pool.options?.max ?? 10;
  pool.waitingCount = waiting;
}

async function gaugeValue(name: string, poolName: string): Promise<number> {
  const metric = await register.getSingleMetric(name)?.get();
  return metric?.values.find((v) => v.labels.pool === poolName)?.value ?? NaN;
}

describe("getPoolStatistics", () => {
  it("derives active clients from total minus idle", () => {
    expect(
      getPoolStatistics(
        fakePool({ totalCount: 8, idleCount: 3, waitingCount: 2 }),
      ),
    ).toEqual({ total: 8, active: 5, idle: 3, waiting: 2, max: 10 });
  });
});

describe("PoolStarvationMonitor", () => {
  const T0 = 1_000_000;
  let pool: PoolCountsSource;
  let onAlert: jest.Mock;
  let onRecover: jest.Mock;
  let monitor: PoolStarvationMonitor;
  let poolName: string;
  let poolCounter = 0;

  beforeEach(() => {
    pool = fakePool();
    onAlert = jest.fn();
    onRecover = jest.fn();
    // Unique label per test keeps the shared Prometheus registry isolated.
    poolName = `test-pool-${++poolCounter}`;
    monitor = new PoolStarvationMonitor(() => pool, {
      poolName,
      waitingThreshold: 5,
      durationMs: 30_000,
      onAlert,
      onRecover,
    });
  });

  afterEach(() => monitor.stop());

  it("does not alert while waiting clients stay at the threshold", () => {
    exhaust(pool, 5);
    monitor.sample(T0);
    monitor.sample(T0 + 60_000);

    expect(onAlert).not.toHaveBeenCalled();
  });

  it("does not alert before the starvation has lasted 30 seconds", () => {
    exhaust(pool, 6);
    monitor.sample(T0);
    const state = monitor.sample(T0 + 29_999);

    expect(onAlert).not.toHaveBeenCalled();
    expect(state?.starving).toBe(false);
    expect(state?.waitingSince).toBe(new Date(T0).toISOString());
  });

  it("alerts once when more than 5 clients wait for 30 seconds", async () => {
    exhaust(pool, 7);
    monitor.sample(T0);
    const state = monitor.sample(T0 + 30_000);
    monitor.sample(T0 + 45_000);

    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith({
      pool: poolName,
      stats: { total: 10, active: 10, idle: 0, waiting: 7, max: 10 },
      waitingThreshold: 5,
      waitingForMs: 30_000,
    });
    expect(state?.starving).toBe(true);
    expect(await gaugeValue("db_pool_starvation_alerts_total", poolName)).toBe(
      1,
    );
    expect(await gaugeValue("db_pool_starvation_active", poolName)).toBe(1);
  });

  it("restarts the 30 second window when waiting drops back in between", () => {
    exhaust(pool, 8);
    monitor.sample(T0);
    pool.waitingCount = 2;
    monitor.sample(T0 + 20_000);
    pool.waitingCount = 8;
    monitor.sample(T0 + 25_000);
    monitor.sample(T0 + 50_000);

    expect(onAlert).not.toHaveBeenCalled();

    monitor.sample(T0 + 55_000);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it("recovers and can alert again on a later starvation", async () => {
    exhaust(pool, 10);
    monitor.sample(T0);
    monitor.sample(T0 + 30_000);

    pool.waitingCount = 0;
    pool.idleCount = 4;
    const recovered = monitor.sample(T0 + 40_000);

    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(recovered?.starving).toBe(false);
    expect(recovered?.waitingSince).toBeNull();
    expect(await gaugeValue("db_pool_starvation_active", poolName)).toBe(0);

    exhaust(pool, 9);
    monitor.sample(T0 + 100_000);
    monitor.sample(T0 + 130_000);

    expect(onAlert).toHaveBeenCalledTimes(2);
    expect(await gaugeValue("db_pool_starvation_alerts_total", poolName)).toBe(
      2,
    );
  });

  it("exports active, idle and waiting gauges to Prometheus", async () => {
    pool.totalCount = 10;
    pool.idleCount = 4;
    pool.waitingCount = 3;
    monitor.sample(T0);

    expect(await gaugeValue("db_pool_active_connections", poolName)).toBe(6);
    expect(await gaugeValue("db_pool_idle_connections", poolName)).toBe(4);
    expect(await gaugeValue("db_pool_waiting_clients", poolName)).toBe(3);
  });

  it("reads the current pool through the getter after replacement", () => {
    let current = fakePool();
    const replaceable = new PoolStarvationMonitor(() => current, {
      poolName,
    });
    replaceable.sample(T0);
    current = fakePool({ waitingCount: 4 });

    expect(replaceable.sample(T0 + 1)?.waiting).toBe(4);
  });

  it("getState() samples on first use for the /health response", () => {
    pool.idleCount = 7;
    expect(monitor.getState()).toMatchObject({
      pool: poolName,
      idle: 7,
      active: 3,
      starving: false,
    });
  });

  it("returns null when no pool is available", () => {
    const empty = new PoolStarvationMonitor(() => null);
    expect(empty.sample(T0)).toBeNull();
  });

  it("samples on an interval once started", () => {
    jest.useFakeTimers();
    try {
      const timed = new PoolStarvationMonitor(() => pool, {
        poolName,
        sampleIntervalMs: 1_000,
      });
      const timedSpy = jest.spyOn(timed, "sample");
      timed.start();
      jest.advanceTimersByTime(3_000);
      timed.stop();
      jest.advanceTimersByTime(3_000);

      expect(timedSpy).toHaveBeenCalledTimes(4); // immediate + 3 ticks
    } finally {
      jest.useRealTimers();
    }
  });
});
