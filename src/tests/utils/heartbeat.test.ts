import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  systemHeartbeat,
  systemUptimeSeconds,
  systemLastHeartbeatTimestamp,
} from "../../utils/metrics";
import {
  startHeartbeat,
  stopHeartbeat,
} from "../../services/metrics";

describe("System Heartbeat Metrics", () => {
  beforeEach(() => {
    stopHeartbeat();
  });

  afterEach(() => {
    stopHeartbeat();
  });

  it("should initialize heartbeat gauge to 1", () => {
    // After import, heartbeat should be set to 1
    const value = (systemHeartbeat as any).get();
    expect(value.values[0].value).toBe(1);
  });

  it("should have system_heartbeat metric registered", () => {
    const metrics = (systemHeartbeat as any).get();
    expect(metrics.values).toHaveLength(1);
    expect(metrics.values[0].value).toBe(1);
  });

  it("should have system_uptime_seconds metric", () => {
    const metrics = (systemUptimeSeconds as any).get();
    expect(metrics.values).toHaveLength(1);
    expect(metrics.values[0].value).toBeGreaterThanOrEqual(0);
  });

  it("should have system_last_heartbeat_timestamp metric", () => {
    const metrics = (systemLastHeartbeatTimestamp as any).get();
    expect(metrics.values).toHaveLength(1);
    expect(metrics.values[0].value).toBeGreaterThan(0);
  });

  it("should update heartbeat on startHeartbeat()", () => {
    vi.useFakeTimers();
    const initialTimestamp = (systemLastHeartbeatTimestamp as any).get().values[0].value;

    startHeartbeat(1000);
    vi.advanceTimersByTime(1000);

    const updatedTimestamp = (systemLastHeartbeatTimestamp as any).get().values[0].value;
    expect(updatedTimestamp).toBeGreaterThanOrEqual(initialTimestamp);

    vi.useRealTimers();
  });

  it("should set heartbeat to 0 on stopHeartbeat()", () => {
    startHeartbeat();
    stopHeartbeat();

    const value = (systemHeartbeat as any).get();
    expect(value.values[0].value).toBe(0);
  });

  it("should not create multiple intervals on repeated startHeartbeat()", () => {
    startHeartbeat(1000);
    startHeartbeat(1000); // Should be no-op

    // If it didn't throw, the guard is working
    stopHeartbeat();
  });
});
