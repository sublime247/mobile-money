import axios from "axios";
import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import logger from "../utils/logger";
import { sendAlert } from "./alertService";
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

// ---------------------------------------------------------------------------
// Recipient velocity (anti-smurfing): per phone number, 24h sliding window.
// ---------------------------------------------------------------------------

export interface RecipientVelocityConfig {
  /** Sliding window length. Defaults to 24 hours. */
  windowMs: number;
  /** Transfers allowed per window; the (maxTransfers + 1)th breaches. */
  maxTransfers: number;
  /** Maximum fiat (XAF) volume per window for one recipient. */
  corridorMaxXaf: number;
  /** When true, transfers to a flagged recipient are held until the window expires. */
  autoHold: boolean;
}

export interface RecipientVelocityEvaluation {
  breached: boolean;
  reasons: string[];
  projectedCount: number;
  projectedVolume: number;
}

export interface RecipientVelocityResult {
  held: boolean;
  evaluation?: RecipientVelocityEvaluation;
}

/** Minimal storage contract so the window logic can be tested without Redis. */
export interface RecipientVelocityStore {
  /** Removes entries scored before `windowStart` and returns the remaining members. */
  pruneAndList(key: string, windowStart: number): Promise<string[]>;
  add(key: string, member: string, score: number, ttlMs: number): Promise<void>;
  setHold(key: string, ttlMs: number): Promise<void>;
  hasHold(key: string): Promise<boolean>;
}

export const RECIPIENT_VELOCITY_KEY_PREFIX = "aml:recipient:velocity:";
export const RECIPIENT_HOLD_KEY_PREFIX = "aml:recipient:hold:";

const DAY_MS = 24 * HOUR_MS;

export function getRecipientVelocityConfig(): RecipientVelocityConfig {
  return {
    windowMs: numberFromEnv("AML_RECIPIENT_WINDOW_MS", DAY_MS),
    maxTransfers: numberFromEnv("AML_RECIPIENT_MAX_TRANSFERS", 10),
    corridorMaxXaf: numberFromEnv("AML_RECIPIENT_CORRIDOR_MAX_XAF", 5_000_000),
    autoHold: process.env.AML_RECIPIENT_AUTO_HOLD === "true",
  };
}

export function isRecipientVelocityEnabled(): boolean {
  return process.env.AML_RECIPIENT_VELOCITY_ENABLED !== "false";
}

export function normalizeRecipientPhone(phone: string): string {
  return phone.replace(/\s+/g, "");
}

/**
 * Pure rule: would the next transfer push the recipient past the transfer
 * count or the corridor volume limit inside the current window?
 */
export function evaluateRecipientVelocity(input: {
  priorCount: number;
  priorVolume: number;
  amount: number;
  config: Pick<RecipientVelocityConfig, "maxTransfers" | "corridorMaxXaf">;
}): RecipientVelocityEvaluation {
  const { priorCount, priorVolume, amount, config } = input;
  const projectedCount = priorCount + 1;
  const projectedVolume = priorVolume + amount;
  const reasons: string[] = [];

  if (projectedCount > config.maxTransfers) {
    reasons.push(
      `Recipient received ${projectedCount} transfers in the rolling window (limit ${config.maxTransfers})`,
    );
  }
  if (projectedVolume > config.corridorMaxXaf) {
    reasons.push(
      `Recipient rolling volume ${projectedVolume} XAF exceeds corridor maximum ${config.corridorMaxXaf} XAF`,
    );
  }

  return {
    breached: reasons.length > 0,
    reasons,
    projectedCount,
    projectedVolume,
  };
}

/** Member format: `<transactionId>|<amount>`. The id makes writes idempotent. */
function encodeRecipientMember(transactionId: string, amount: number): string {
  return `${transactionId}|${amount}`;
}

function decodeRecipientMember(member: string): { id: string; amount: number } {
  const separator = member.lastIndexOf("|");
  return {
    id: member.slice(0, separator),
    amount: Number(member.slice(separator + 1)),
  };
}

/** Redis-backed sliding window using a sorted set scored by timestamp. */
export function createRedisRecipientVelocityStore(
  client: typeof redisClient = redisClient,
): RecipientVelocityStore {
  return {
    async pruneAndList(key, windowStart) {
      const results = (await client
        .multi()
        .zRemRangeByScore(key, 0, windowStart)
        .zRangeByScore(key, windowStart, "+inf")
        .exec()) as unknown as [unknown, string[]];
      return results[1] ?? [];
    },
    async add(key, member, score, ttlMs) {
      await client
        .multi()
        .zAdd(key, [{ score, value: member }])
        .pExpire(key, ttlMs)
        .exec();
    },
    async setHold(key, ttlMs) {
      await client.set(key, "1", { PX: ttlMs });
    },
    async hasHold(key) {
      return Number(await client.exists(key)) > 0;
    },
  };
}

/** Sends the Slack alert and, when a routing key is configured, a PagerDuty event. */
export async function dispatchRecipientVelocityAlert(params: {
  transactionId: string;
  maskedRecipient: string;
  reasons: string[];
  projectedCount: number;
  projectedVolume: number;
}): Promise<void> {
  const summary = `AML recipient velocity breach: ${params.reasons.join("; ")}`;

  try {
    await sendAlert(
      {
        transactionId: params.transactionId,
        provider: "aml-recipient-velocity",
        error: summary,
        severity: "critical",
        meta: {
          recipient: params.maskedRecipient,
          transfers24h: params.projectedCount,
          volumeXaf: params.projectedVolume,
        },
      },
      { cooldownMs: 0 },
    );
  } catch (error) {
    logger.error({ error }, "[AML-RECIPIENT] Slack alert dispatch failed");
  }

  const routingKey = process.env.PAGERDUTY_ROUTING_KEY;
  if (!routingKey) return;

  try {
    await axios.post(
      "https://events.pagerduty.com/v2/enqueue",
      {
        routing_key: routingKey,
        event_action: "trigger",
        dedup_key: `aml-recipient-${params.transactionId}`,
        payload: {
          summary,
          timestamp: new Date().toISOString(),
          severity: "critical",
          source: "mobile-money-aml",
          custom_details: {
            transactionId: params.transactionId,
            recipient: params.maskedRecipient,
            transfers24h: params.projectedCount,
            volumeXaf: params.projectedVolume,
          },
        },
      },
      { timeout: 5000 },
    );
  } catch (error) {
    logger.error({ error }, "[AML-RECIPIENT] PagerDuty event dispatch failed");
  }
}

export class RecipientVelocityMonitor {
  private readonly transactionModel = new TransactionModel();

  constructor(
    private readonly store: RecipientVelocityStore = createRedisRecipientVelocityStore(),
  ) {}

  /**
   * Records a transfer against the recipient's window and evaluates it.
   * A breach holds this transfer, raises a critical alert, and (when
   * AML_RECIPIENT_AUTO_HOLD=true) holds later transfers to the same recipient
   * until the window expires. Infrastructure errors are thrown to the caller,
   * which fails open like the other AML pre-dispatch checks.
   */
  async check(
    transaction: { id: string; phoneNumber: string; amount: number },
    options: {
      config?: RecipientVelocityConfig;
      now?: number;
      notify?: typeof dispatchRecipientVelocityAlert;
    } = {},
  ): Promise<RecipientVelocityResult> {
    if (!isRecipientVelocityEnabled()) return { held: false };

    const phone = normalizeRecipientPhone(transaction.phoneNumber);
    if (!phone || !Number.isFinite(transaction.amount)) return { held: false };

    const config = options.config ?? getRecipientVelocityConfig();
    const now = options.now ?? Date.now();
    const velocityKey = `${RECIPIENT_VELOCITY_KEY_PREFIX}${phone}`;
    const holdKey = `${RECIPIENT_HOLD_KEY_PREFIX}${phone}`;

    const members = await this.store.pruneAndList(velocityKey, now - config.windowMs);
    const seen = new Set<string>();
    let priorCount = 0;
    let priorVolume = 0;
    for (const member of members) {
      const decoded = decodeRecipientMember(member);
      if (decoded.id === transaction.id || seen.has(decoded.id)) continue;
      seen.add(decoded.id);
      priorCount += 1;
      priorVolume += decoded.amount;
    }

    const alreadyRecorded = members.some(
      (member) => decodeRecipientMember(member).id === transaction.id,
    );
    if (!alreadyRecorded) {
      await this.store.add(
        velocityKey,
        encodeRecipientMember(transaction.id, transaction.amount),
        now,
        config.windowMs,
      );
    }

    const evaluation = evaluateRecipientVelocity({
      priorCount,
      priorVolume,
      amount: transaction.amount,
      config,
    });

    const autoHeld = config.autoHold && (await this.store.hasHold(holdKey));
    if (!evaluation.breached && !autoHeld) {
      return { held: false, evaluation };
    }

    if (evaluation.breached && config.autoHold) {
      await this.store.setHold(holdKey, config.windowMs);
    }

    const held = await this.transactionModel.updateStatus(
      transaction.id,
      TransactionStatus.PendingReview,
      undefined,
      [TransactionStatus.Pending],
    );
    if (!held) {
      logger.warn(
        { transactionId: transaction.id },
        "[AML-RECIPIENT] Could not move transaction to pending_review; status already changed",
      );
      return { held: false, evaluation };
    }

    if (evaluation.breached) {
      const notify = options.notify ?? dispatchRecipientVelocityAlert;
      await notify({
        transactionId: transaction.id,
        maskedRecipient: `***${phone.slice(-4)}`,
        reasons: evaluation.reasons,
        projectedCount: evaluation.projectedCount,
        projectedVolume: evaluation.projectedVolume,
      });
    }

    logger.info(
      {
        transactionId: transaction.id,
        breached: evaluation.breached,
        autoHeld,
      },
      "[AML-RECIPIENT] Transaction held by recipient velocity monitor",
    );
    return { held: true, evaluation };
  }
}

export const recipientVelocityMonitor = new RecipientVelocityMonitor();
