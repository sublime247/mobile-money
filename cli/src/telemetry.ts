import { getTelemetryEnabled } from "./config";

export interface TelemetryEvent {
  command: string;
  success: boolean;
  durationMs?: number;
}

/**
 * Tracks an anonymous CLI usage event.
 * No-ops silently if telemetry is disabled.
 *
 * Replace the console.debug stub below with a real
 * analytics call (e.g. POST to your ingestion endpoint)
 * when you are ready to collect data.
 */
export function trackEvent(event: TelemetryEvent): void {
  if (!getTelemetryEnabled()) {
    return;
  }

  // --- Stub: swap this for a real analytics call ---
  // e.g. axios.post("https://telemetry.example.com/events", event).catch(() => {});
  console.debug("[telemetry]", JSON.stringify(event));
  // -------------------------------------------------
}
