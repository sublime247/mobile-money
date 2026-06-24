import { systemHeartbeat } from "../utils/metrics";

/**
 * HeartbeatService manages the system heartbeat metric.
 * The heartbeat is a gauge that reports baseline availability state consistently.
 * 
 * Value: 1 = available, 0 = unavailable
 * 
 * This metric is useful for:
 * - Monitoring system uptime and availability
 * - Alerting on service degradation
 * - Dashboarding overall system health
 */

const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.HEARTBEAT_INTERVAL_MS || "30000",
); // Default: 30 seconds

let heartbeatInterval: NodeJS.Timeout | null = null;

/**
 * Start the heartbeat service.
 * Updates the system_heartbeat metric every HEARTBEAT_INTERVAL_MS.
 */
export function startHeartbeatService(): void {
  console.log(
    `[Heartbeat Service] Starting with interval ${HEARTBEAT_INTERVAL_MS}ms`,
  );

  // Set initial heartbeat immediately
  updateHeartbeat();

  // Schedule periodic updates
  heartbeatInterval = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the heartbeat service.
 * Clears the interval and sets the heartbeat to 0 (unavailable).
 */
export function stopHeartbeatService(): void {
  console.log("[Heartbeat Service] Stopping");

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Mark as unavailable when stopping
  systemHeartbeat.set({ service: "mobile-money" }, 0);
}

/**
 * Update the heartbeat metric.
 * Sets the metric to 1 (available) to indicate the system is running.
 */
function updateHeartbeat(): void {
  try {
    systemHeartbeat.set({ service: "mobile-money" }, 1);
  } catch (error) {
    console.error("[Heartbeat Service] Failed to update heartbeat:", error);
  }
}

/**
 * Get the current heartbeat status.
 * Useful for testing and debugging.
 */
export async function getHeartbeatStatus(): Promise<number> {
  try {
    // Access the internal metric value
    const metrics = await systemHeartbeat.get();
    const heartbeatMetric = metrics.values.find(
      (v: any) => v.labels.service === "mobile-money",
    );
    return heartbeatMetric ? heartbeatMetric.value : 0;
  } catch (error) {
    console.error("[Heartbeat Service] Failed to get heartbeat status:", error);
    return 0;
  }
}
