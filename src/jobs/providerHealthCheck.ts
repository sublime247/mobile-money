import logger from "../utils/logger";
import {
  checkMobileMoneyHealth,
  ProviderName,
} from "../services/mobilemoney/providers/healthCheck";
import { checkAndResetCircuitBreaker } from "../utils/circuitBreaker";
import { createPagerDutyService } from "../services/pagerDutyService";

// ─── Types ────────────────────────────────────────────────────────────────────

interface IncidentRecord {
  provider: ProviderName;
  triggeredAt: string;
  dedupeKey: string;
}

// ─── Module-level incident state ──────────────────────────────────────────────
// Persists across cron invocations within the same process so we can resolve
// incidents when a provider recovers without re-triggering on every run.

const activeIncidents = new Map<ProviderName, IncidentRecord>();

// ─── PagerDuty helpers ────────────────────────────────────────────────────────

const PAGERDUTY_API = "https://events.pagerduty.com/v2/enqueue";
const INTEGRATION_KEY = process.env.PAGERDUTY_INTEGRATION_KEY ?? "";
const DEDUP_PREFIX =
  process.env.PAGERDUTY_DEDUP_KEY ?? "mobile-money-provider-watchdog";

function dedupeKey(provider: ProviderName): string {
  return `${DEDUP_PREFIX}-${provider}-outage`;
}

interface PagerDutyPayload {
  routing_key: string;
  event_action: "trigger" | "resolve";
  dedup_key: string;
  payload: {
    summary: string;
    timestamp: string;
    severity: "critical" | "info";
    source: string;
    custom_details: Record<string, unknown>;
  };
}

async function sendPagerDutyEvent(body: PagerDutyPayload): Promise<void> {
  if (!INTEGRATION_KEY) {
    log("warn", "PAGERDUTY_INTEGRATION_KEY not set — skipping PagerDuty event", {
      event_action: body.event_action,
      provider: body.payload.custom_details.provider,
    });
    return;
  }

  const response = await fetch(PAGERDUTY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `PagerDuty API responded with HTTP ${response.status}: ${await response.text()}`,
    );
  }
}

async function triggerOutageIncident(
  provider: ProviderName,
  responseTime: number | null,
): Promise<void> {
  const key = dedupeKey(provider);
  const now = new Date().toISOString();

  await sendPagerDutyEvent({
    routing_key: INTEGRATION_KEY,
    event_action: "trigger",
    dedup_key: key,
    payload: {
      summary: `[CRITICAL] Mobile money provider ${provider.toUpperCase()} is DOWN`,
      timestamp: now,
      severity: "critical",
      source: "mobile-money-provider-watchdog",
      custom_details: {
        provider,
        status: "down",
        responseTime: responseTime ?? "timeout",
        environment: process.env.NODE_ENV ?? "development",
        detectedAt: now,
      },
    },
  });

  activeIncidents.set(provider, { provider, triggeredAt: now, dedupeKey: key });

  log("error", "Provider outage incident triggered", {
    provider,
    dedupeKey: key,
    responseTime,
  });
}

async function resolveOutageIncident(
  provider: ProviderName,
  responseTime: number | null,
): Promise<void> {
  const incident = activeIncidents.get(provider);
  if (!incident) return; // nothing to resolve

  const now = new Date().toISOString();

  await sendPagerDutyEvent({
    routing_key: INTEGRATION_KEY,
    event_action: "resolve",
    dedup_key: incident.dedupeKey,
    payload: {
      summary: `[RESOLVED] Mobile money provider ${provider.toUpperCase()} is back UP`,
      timestamp: now,
      severity: "info",
      source: "mobile-money-provider-watchdog",
      custom_details: {
        provider,
        status: "up",
        responseTime: responseTime ?? "unknown",
        environment: process.env.NODE_ENV ?? "development",
        resolvedAt: now,
        outageStartedAt: incident.triggeredAt,
      },
    },
  });

  activeIncidents.delete(provider);

  log("info", "Provider outage incident resolved", {
    provider,
    dedupeKey: incident.dedupeKey,
    responseTime,
    outageStartedAt: incident.triggeredAt,
  });
}

// ─── Structured logger ────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";

function log(
  level: LogLevel,
  message: string,
  meta: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "provider-watchdog",
    message,
    ...meta,
  });
  if (level === "error") {
    logger.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ─── Circuit-breaker reset helper ─────────────────────────────────────────────

const CIRCUIT_OPERATIONS = ["requestPayment", "sendPayout"] as const;

async function tryResetCircuitBreakers(provider: ProviderName): Promise<void> {
  for (const operation of CIRCUIT_OPERATIONS) {
    try {
      const wasReset = await checkAndResetCircuitBreaker(provider, operation);
      if (wasReset) {
        log("info", "Circuit breaker reset", { provider, operation });
      }
    } catch (err) {
      log("warn", "Failed to reset circuit breaker", {
        provider,
        operation,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Provider Status Watchdog — runs every 5 minutes via the cron scheduler.
 *
 * For each provider (MTN, Airtel, Orange):
 *   - Pings the health endpoint via checkMobileMoneyHealth()
 *   - If DOWN and no active incident → triggers a CRITICAL PagerDuty incident
 *   - If UP and an active incident exists → resolves the PagerDuty incident
 *   - If UP → attempts to reset any open circuit breakers
 *
 * Incident state is kept in-process so repeated "down" runs don't re-trigger
 * the same incident (PagerDuty dedup_key also guards against this).
 */
export async function runProviderHealthCheckJob(): Promise<void> {
  log("info", "Provider watchdog starting");

  // Bypass the 5-minute Redis cache so the watchdog always gets a fresh read.
  // We pass an empty providers list override to force a live ping.
  const healthResult = await checkMobileMoneyHealth(
    undefined, // use DEFAULT_PROVIDERS
    fetch,
  );

  const providers = Object.entries(healthResult.providers) as [
    ProviderName,
    { status: "up" | "down"; responseTime: number | null },
  ][];

  const downProviders: ProviderName[] = [];
  const upProviders: ProviderName[] = [];

  for (const [provider, health] of providers) {
    if (health.status === "down") {
      downProviders.push(provider);
    } else {
      upProviders.push(provider);
    }
  }

  log("info", "Health check complete", {
    up: upProviders,
    down: downProviders,
    activeIncidents: [...activeIncidents.keys()],
  });

  // ── Handle DOWN providers ──────────────────────────────────────────────────
  for (const provider of downProviders) {
    const health = healthResult.providers[provider];

    if (!activeIncidents.has(provider)) {
      try {
        await triggerOutageIncident(provider, health.responseTime);
      } catch (err) {
        log("error", "Failed to trigger PagerDuty incident", {
          provider,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log("warn", "Provider still down — incident already active", {
        provider,
        activeIncidentSince: activeIncidents.get(provider)?.triggeredAt,
      });
    }
  }

  // ── Handle UP providers ────────────────────────────────────────────────────
  for (const provider of upProviders) {
    const health = healthResult.providers[provider];

    // Resolve any open incident first
    if (activeIncidents.has(provider)) {
      try {
        await resolveOutageIncident(provider, health.responseTime);
      } catch (err) {
        log("error", "Failed to resolve PagerDuty incident", {
          provider,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Reset circuit breakers so traffic can resume
    await tryResetCircuitBreakers(provider);
  }

  if (downProviders.length === 0) {
    log("info", "All providers operational");
  } else {
    log("warn", "Provider watchdog finished with outages", {
      downProviders,
      incidentCount: activeIncidents.size,
    });
  }
}

// ─── Exported for testing ─────────────────────────────────────────────────────

/** Returns a snapshot of currently active incidents (provider → record). */
export function getActiveIncidents(): ReadonlyMap<ProviderName, IncidentRecord> {
  return activeIncidents;
}

/** Clears all tracked incidents — use only in tests. */
export function _resetActiveIncidents(): void {
  activeIncidents.clear();
}

// Keep the PagerDuty service instance alive for the error-rate monitoring loop
// that the rest of the app relies on (MonitoringService uses it).
export { createPagerDutyService };
