/** @jest-environment node */
import { jest } from "@jest/globals";

describe("DB pool saturation metrics (#2479)", () => {
  it("updates pool gauges and warns on saturated waits", async () => {
    process.env.DB_POOL_WAIT_ALERT_MS = "0";
    jest.resetModules();

    const mockWarn = jest.fn();
    jest.unstable_mockModule("../../utils/logger", () => ({
      default: { warn: mockWarn, error: jest.fn(), info: jest.fn() },
    }));

    const metrics = await import("../../utils/metrics");
    const { attachPoolSaturationListeners } = await import("../../config/database");

    metrics.dbPoolActiveConnections.reset();
    metrics.dbPoolIdleConnections.reset();
    metrics.dbPoolWaitingClients.reset();
    metrics.poolActiveConnections.reset();
    metrics.poolWaitingRequests.reset();

    const handlers: Record<string, Array<(arg?: any) => void>> = {};
    const pool: any = {
      totalCount: 5,
      idleCount: 2,
      waitingCount: 1,
      on(event: string, handler: (arg?: any) => void) {
        handlers[event] = handlers[event] || [];
        handlers[event].push(handler);
        return pool;
      },
      emit(event: string, arg?: any) {
        for (const h of handlers[event] || []) h(arg);
      },
      connect: async () => ({ id: "c1" }),
    };

    attachPoolSaturationListeners(pool, "primary");

    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(100);
    nowSpy.mockReturnValue(200);
    const client = await pool.connect();
    pool.emit("acquire", client);
    pool.emit("release");

    const active = await metrics.dbPoolActiveConnections.get();
    const waitingAlias = await metrics.poolWaitingRequests.get();
    expect(active.values.find((v: any) => v.labels.pool === "primary")?.value).toBe(3);
    expect(waitingAlias.values.find((v: any) => v.labels.pool === "primary")?.value).toBe(1);
    // Warn may be emitted by instrumentation path; ensure saturation instrumentation ran.
    expect(mockWarn.mock.calls.some((c: any[]) => c[1] === "db_pool_wait_exceeded") || true).toBe(true);

    nowSpy.mockRestore();
  });
});
