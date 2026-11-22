import { pool } from "../config/database";
import logger from "../utils/logger";
import {
  amlService,
  type AMLAlert,
  type AMLRuleHit,
  type AMLTransactionRecord,
} from "./aml";
import { TransactionModel, TransactionStatus } from "../models/transaction";

/**
 * AML velocity monitoring.
 *
 * Tracks each customer's cumulative transaction volume over rolling 1-hour,
 * 24-hour and 30-day windows. When the projected volume (history + the new
 * transaction) breaches a window's threshold the transaction is flagged for
 * manual compliance review and held in the PENDING_REVIEW state, so it is never
 * dispatched to the mobile money provider until a compliance officer acts.
 */

export type VelocityWindowName = "1h" | "24h" | "30d";

export interface VelocityWindowConfig {
  name: VelocityWindowName;
  durationMs: number;
  thresholdXaf: number;
}

export interface VelocityWindowVolume {
  volume: number;
  count: number;
}

export type VelocityVolumes = Record<VelocityWindowName, VelocityWindowVolume>;

export interface VelocityEvaluation {
  breached: boolean;
  ruleHits: AMLRuleHit[];
  projected: Record<VelocityWindowName, number>;
}

export interface VelocityEnforcementResult {
  held: boolean;
  alert?: AMLAlert;
  evaluation?: VelocityEvaluation;
}

const HOUR_MS = 60 * 60 * 1000;

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getVelocityWindows(): VelocityWindowConfig[] {
  return [
    {
      name: "1h",
      durationMs: HOUR_MS,
      thresholdXaf: numberFromEnv("AML_VELOCITY_1H_VOLUME_XAF", 2_000_000),
    },
    {
      name: "24h",
      durationMs: 24 * HOUR_MS,
      thresholdXaf: numberFromEnv("AML_VELOCITY_24H_VOLUME_XAF", 5_000_000),
    },
    {
      name: "30d",
      durationMs: 30 * 24 * HOUR_MS,
      thresholdXaf: numberFromEnv("AML_VELOCITY_30D_VOLUME_XAF", 30_000_000),
    },
  ];
}

export function isVelocityMonitoringEnabled(): boolean {
  return process.env.AML_VELOCITY_ENABLED !== "false";
}

/**
 * Pure rule evaluation: does adding `amount` to the observed rolling volumes
 * push the customer over any window threshold?
 */
export function evaluateVelocity(
  amount: number,
  volumes: VelocityVolumes,
  windows: VelocityWindowConfig[] = getVelocityWindows(),
): VelocityEvaluation {
  const ruleHits: AMLRuleHit[] = [];
  const projected = {} as Record<VelocityWindowName, number>;

  for (const window of windows) {
    const total = volumes[window.name].volume + amount;
    projected[window.name] = total;

    if (total > window.thresholdXaf) {
      ruleHits.push({
        rule: "velocity_threshold",
        message: `Rolling ${window.name} volume ${total} XAF (${volumes[window.name].count + 1} tx) exceeds velocity threshold ${window.thresholdXaf} XAF`,
        observed: total,
        threshold: window.thresholdXaf,
      });
    }
  }

  return { breached: ruleHits.length > 0, ruleHits, projected };
}

export class AMLVelocityService {
  private readonly transactionModel = new TransactionModel();

  /**
   * Cumulative volume per window for a customer, excluding the transaction
   * being evaluated and transactions that never moved money.
   */
  async getRollingVolumes(
    userId: string,
    now: Date,
    excludeTransactionId?: string,
    windows: VelocityWindowConfig[] = getVelocityWindows(),
  ): Promise<VelocityVolumes> {
    const byName = Object.fromEntries(windows.map((w) => [w.name, w])) as Record<
      VelocityWindowName,
      VelocityWindowConfig
    >;
    const start = (name: VelocityWindowName) =>
      new Date(now.getTime() - byName[name].durationMs);
    const widest = new Date(
      now.getTime() - Math.max(...windows.map((w) => w.durationMs)),
    );

    const result = await pool.query<{
      volume_1h: string;
      count_1h: string;
      volume_24h: string;
      count_24h: string;
      volume_30d: string;
      count_30d: string;
    }>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE created_at >= $3), 0)::text AS volume_1h,
         COUNT(*) FILTER (WHERE created_at >= $3)::text AS count_1h,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= $4), 0)::text AS volume_24h,
         COUNT(*) FILTER (WHERE created_at >= $4)::text AS count_24h,
         COALESCE(SUM(amount), 0)::text AS volume_30d,
         COUNT(*)::text AS count_30d
       FROM transactions
       WHERE user_id = $1
         AND created_at >= $2
         AND ($5::uuid IS NULL OR id <> $5::uuid)
         AND status NOT IN ('failed', 'cancelled', 'expired')`,
      [
        userId,
        widest,
        start("1h"),
        start("24h"),
        excludeTransactionId ?? null,
      ],
    );

    const row = result.rows[0];
    return {
      "1h": { volume: Number(row.volume_1h), count: Number(row.count_1h) },
      "24h": { volume: Number(row.volume_24h), count: Number(row.count_24h) },
      "30d": { volume: Number(row.volume_30d), count: Number(row.count_30d) },
    };
  }

  /**
   * Evaluates velocity for a freshly created transaction. On a breach, raises
   * an AML alert (flagging it for manual review) and moves the transaction to
   * PENDING_REVIEW so the caller must not dispatch it.
   */
  async enforce(
    transaction: AMLTransactionRecord,
  ): Promise<VelocityEnforcementResult> {
    if (!isVelocityMonitoringEnabled()) return { held: false };

    const windows = getVelocityWindows();
    const volumes = await this.getRollingVolumes(
      transaction.userId,
      transaction.createdAt,
      transaction.id,
      windows,
    );
    const evaluation = evaluateVelocity(transaction.amount, volumes, windows);
    if (!evaluation.breached) return { held: false, evaluation };

    // Hold first so a failure while alerting can never let the payment through.
    const held = await this.transactionModel.updateStatus(
      transaction.id,
      TransactionStatus.PendingReview,
      undefined,
      [TransactionStatus.Pending],
    );
    if (!held) {
      logger.warn(
        { transactionId: transaction.id },
        "[AML-VELOCITY] Could not move transaction to pending_review; status already changed",
      );
      return { held: false, evaluation };
    }

    const severity = evaluation.ruleHits.length > 1 ? "high" : "medium";
    const alert = await amlService.raiseAlert(
      transaction,
      evaluation.ruleHits,
      severity,
    );

    await Promise.all([
      this.transactionModel.addTags(transaction.id, [
        "aml-flagged",
        "aml-velocity",
        "pending-review",
      ]),
      this.transactionModel.patchMetadata(transaction.id, {
        amlVelocity: {
          alertId: alert.id,
          projectedVolumesXaf: evaluation.projected,
          reasons: alert.reasons,
          heldAt: new Date().toISOString(),
        },
      }),
      this.transactionModel.updateAdminNotes(
        transaction.id,
        `[AML-VELOCITY:${alert.id}] ${alert.reasons.join(" | ")}`.slice(0, 1000),
      ),
    ]);

    return { held: true, alert, evaluation };
  }

  /**
   * Compliance decision on a held transaction.
   * - "release": back to Pending and re-enqueued for provider dispatch.
   * - "reject": cancelled; never dispatched.
   * Returns false when the transaction is not currently held.
   */
  async resolveHold(
    transactionId: string,
    decision: "release" | "reject",
    reviewedBy: string,
  ): Promise<boolean> {
    const target =
      decision === "release"
        ? TransactionStatus.Pending
        : TransactionStatus.Cancelled;

    const updated = await this.transactionModel.updateStatus(
      transactionId,
      target,
      undefined,
      [TransactionStatus.PendingReview],
    );
    if (!updated) return false;

    await this.transactionModel.patchMetadata(transactionId, {
      amlVelocityResolution: {
        decision,
        reviewedBy,
        resolvedAt: new Date().toISOString(),
      },
    });

    if (decision === "release") {
      const tx = await this.transactionModel.findById(transactionId);
      if (tx) {
        const { addTransactionJob } = await import("../queue/transactionQueue");
        await addTransactionJob(
          {
            transactionId: tx.id,
            type: tx.type as "deposit" | "withdraw",
            amount: String(tx.amount),
            phoneNumber: tx.phoneNumber,
            provider: tx.provider,
            stellarAddress: tx.stellarAddress ?? "",
          },
          { jobId: tx.id },
        );
      }
    }

    logger.info(
      { transactionId, decision, reviewedBy },
      "[AML-VELOCITY] Held transaction resolved",
    );
    return true;
  }
}

export const amlVelocityService = new AMLVelocityService();
