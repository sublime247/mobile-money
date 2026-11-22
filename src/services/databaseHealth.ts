/**
 * src/services/databaseHealth.ts (#2484)
 *
 * Presents the replica-lag data gathered by the existing monitor in
 * `src/config/database.ts` in a form suitable for health endpoints:
 *   - lag expressed in milliseconds (the monitor stores seconds)
 *   - the last replayed WAL LSN from pg_last_wal_replay_lsn()
 *   - a separate 10s alert threshold, independent of the 5s routing cutoff
 *
 * The underlying SQL (pg_last_xact_replay_timestamp + pg_last_wal_replay_lsn)
 * deliberately stays in the single existing probe so we never open an extra
 * connection per health request. By default this service reads the cached
 * snapshot refreshed every 10s by `startReplicaLagMonitor()`; callers may pass
 * `fresh: true` to trigger an on-demand probe for debugging.
 */

import {
  ReplicaPoolStatus,
  checkReplicaHealth,
  getReplicaPoolStatus,
} from "../config/database";

/** A replica more than 10 seconds behind primary is an operational alert. */
export const REPLICATION_LAG_ALERT_THRESHOLD_MS = (() => {
  const parsed = parseInt(
    process.env.REPLICATION_LAG_ALERT_THRESHOLD_MS || "10000",
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10000;
})();

export interface ReplicaLagStatus {
  url: string;
  healthy: boolean;
  enabled: boolean;
  /** Replication lag in milliseconds; null when unknown. */
  lagMs: number | null;
  /** pg_last_wal_replay_lsn() from the replica, or null when not in recovery. */
  walReplayLsn: string | null;
  /** True when this replica is more than the alert threshold behind. */
  alert: boolean;
}

export interface ReplicationLagReport {
  status: "ok" | "degraded" | "unavailable";
  replicas: ReplicaLagStatus[];
  /** Worst known lag across replicas, in milliseconds. */
  maxLagMs: number | null;
  /** True when any replica exceeds the alert threshold. */
  alert: boolean;
  thresholdMs: number;
  checkedAt: string;
}

function toLagStatus(replica: ReplicaPoolStatus): ReplicaLagStatus {
  const lagMs =
    replica.lagSeconds !== null && Number.isFinite(replica.lagSeconds)
      ? Math.max(0, Math.round(replica.lagSeconds * 1000))
      : null;

  return {
    url: replica.url,
    healthy: replica.healthy,
    enabled: replica.enabled,
    lagMs,
    walReplayLsn: replica.walReplayLsn ?? null,
    alert: lagMs !== null && lagMs > REPLICATION_LAG_ALERT_THRESHOLD_MS,
  };
}

/**
 * Build a replication-lag report from the cached snapshot (default) or from a
 * fresh probe of every replica (`fresh: true`). The hot path never performs a
 * database round trip.
 */
export async function getReplicationLagReport(
  options: { fresh?: boolean } = {},
): Promise<ReplicationLagReport> {
  const replicas: ReplicaPoolStatus[] = options.fresh
    ? await checkReplicaHealth()
    : getReplicaPoolStatus();

  const statuses = replicas.map(toLagStatus);
  const knownLags = statuses
    .map((r) => r.lagMs)
    .filter((lag): lag is number => lag !== null);
  const maxLagMs = knownLags.length > 0 ? Math.max(...knownLags) : null;
  const alert = statuses.some((r) => r.alert);

  let status: ReplicationLagReport["status"] = "ok";
  if (statuses.length === 0) {
    status = "unavailable";
  } else if (!statuses.some((r) => r.healthy) || alert) {
    status = "degraded";
  }

  return {
    status,
    replicas: statuses,
    maxLagMs,
    alert,
    thresholdMs: REPLICATION_LAG_ALERT_THRESHOLD_MS,
    checkedAt: new Date().toISOString(),
  };
}
