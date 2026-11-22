import { AuditService } from "./auditService";
import { AuditLog } from "../models/auditLog";
import logger from "../utils/logger";

/**
 * Structured audit event logger for maker-checker approvals and
 * administrative overrides (#2358).
 *
 * This is a thin, purpose-named wrapper around the existing tamper-evident
 * `AuditService` (SHA-256 hash-chained entries persisted to the partitioned
 * `audit_logs` table - see migrations/20260826_partition_audit_logs.sql and
 * migrations/20261020_migrate_audit_logs_to_monthly_partitions.sql). It does
 * not duplicate that persistence/integrity logic; it gives admin endpoints a
 * single, explicit entry point - `recordAdminAction` - for emitting an audit
 * event with a before/after diff, so every state-changing administrative
 * action (maker-checker approvals/rejections, manual fee adjustments, user
 * blacklisting, compliance freezes, etc.) is captured the same way.
 */

const auditService = new AuditService();

export interface AdminActionContext {
  /** ID of the admin/actor who performed the action. */
  actorId: string;
  /** Action identifier, e.g. "MAKER_CHECKER_APPROVE", "USER_BLACKLIST". */
  action: string;
  /** Logical resource type being acted on, e.g. "maker_checker_action", "user". */
  resource: string;
  /** ID of the specific resource instance (the "target"), when applicable. */
  resourceId?: string | null;
  /**
   * State of the entity before the action. `null`/`undefined` is valid and
   * expected for actions that create a new entity (no prior state exists).
   */
  before?: Record<string, unknown> | null;
  /** State of the entity after the action. */
  after?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Builds a shallow before/after diff limited to keys that changed (added,
 * removed, or whose value differs). Values are compared via JSON
 * stringification so nested objects/arrays are diffed by content rather than
 * reference. This intentionally stays shallow + simple (no deep patch
 * format): the stored `diff` is a durable compliance record meant to be
 * human-read during an investigation, not replayed programmatically.
 */
export function buildDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const beforeObj = before ?? {};
  const afterObj = after ?? {};
  const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);

  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of keys) {
    const beforeValue = beforeObj[key];
    const afterValue = afterObj[key];
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      diff[key] = { before: beforeValue ?? null, after: afterValue ?? null };
    }
  }

  return {
    // `before === null/undefined` (e.g. a creation) is recorded explicitly
    // rather than silently treated as "no prior state to diff against".
    hadPriorState: before !== null && before !== undefined,
    changed: diff,
  };
}

/**
 * Records an immutable, tamper-evident audit event for a state-changing
 * administrative action. Call this from every admin controller/route that
 * approves, rejects, overrides, freezes, or otherwise mutates state on
 * behalf of an administrator.
 *
 * Never throws: an audit-logging failure must not be allowed to block or
 * roll back the administrative action it is describing (the action has
 * already happened by the time this is called). Failures are logged at
 * `error` level so they are loud in observability tooling without taking
 * down the request.
 */
export async function recordAdminAction(
  context: AdminActionContext,
): Promise<AuditLog | null> {
  try {
    const diff = buildDiff(context.before, context.after);

    return await auditService.logAdminAction({
      adminId: context.actorId,
      action: context.action,
      resource: context.resource,
      resourceId: context.resourceId ?? null,
      diff,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });
  } catch (error) {
    logger.error(
      {
        error,
        actorId: context.actorId,
        action: context.action,
        resource: context.resource,
        resourceId: context.resourceId,
      },
      "Failed to record admin audit event",
    );
    return null;
  }
}

export { auditService as auditLoggerService };
