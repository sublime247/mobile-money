import * as crypto from "crypto";
import { pool } from "../config/database";
import {
  CachedAmlProfileSnapshot,
  getCachedAmlProfileSnapshot,
} from "./cachedTransactionService";
import { getDistanceKm } from "./fraud";
import { sanctionService } from "./sanctionService";

export type AMLTransactionType = "deposit" | "withdraw";
export type AMLAlertStatus = "pending_review" | "reviewed" | "dismissed";
export type AMLAlertSeverity = "medium" | "high";
export type AMLRecommendedAction = "allow" | "review";
export type AMLRule =
  | "single_transaction_threshold"
  | "daily_total_threshold"
  | "rapid_structuring"
  | "sanction_match"
  | "dynamic_profile_score";

export interface AMLTransactionLocation {
  lat: number;
  lng: number;
}

export interface AMLTransactionRecord {
  id: string;
  userId: string;
  type: AMLTransactionType;
  amount: number;
  createdAt: Date;
  status?: string;
  locationMetadata?: Record<string, unknown> | null;
}

export interface AMLRuleHit {
  rule: AMLRule;
  message: string;
  observed: number;
  threshold: number;
}

export interface AMLAlert {
  id: string;
  transactionId: string;
  userId: string;
  severity: AMLAlertSeverity;
  status: AMLAlertStatus;
  ruleHits: AMLRuleHit[];
  reasons: string[];
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNotes?: string;
}

export interface AMLReviewInput {
  status: Exclude<AMLAlertStatus, "pending_review">;
  reviewedBy: string;
  reviewNotes?: string;
}

export interface AMLRiskProfile {
  historicalCount: number;
  countLastHour: number;
  countLast24Hours: number;
  countLast7Days: number;
  movingAverageAmount: number;
  amountVsAverageRatio: number;
  hourlyVelocityRatio: number;
  dailyVelocityRatio: number;
  averageDailyCount: number;
  frequencySpikeRatio: number;
  geographicHopDistanceKm: number | null;
  geographicHopHours: number | null;
}

export interface AMLConfig {
  singleTransactionThresholdXaf: number;
  dailyTotalThresholdXaf: number;
  rollingWindowHours: number;
  rapidWindowMinutes: number;
  rapidTransactionCount: number;
  structuringFloorXaf: number;
  alertBufferSize: number;
  profileScoreThreshold: number;
  velocityHourlyCap: number;
  velocityDailyCap: number;
  movingAverageWindowDays: number;
  amountMultiplierLimit: number;
  frequencySpikeMultiplier: number;
  geoHopMaxKm: number;
  geoHopMaxHours: number;
}

export interface AMLMonitoringResult {
  flagged: boolean;
  alert?: AMLAlert;
  ruleHits: AMLRuleHit[];
  riskScore: number;
  scoreThreshold: number;
  recommendedAction: AMLRecommendedAction;
  reasons: string[];
  profile?: AMLRiskProfile;
}

export interface AMLReport {
  period: { start: string; end: string };
  summary: {
    totalAlerts: number;
    pendingReview: number;
    reviewed: number;
    dismissed: number;
    highSeverity: number;
    mediumSeverity: number;
  };
  byRule: Record<AMLRule, number>;
  daily: Array<{ date: string; alerts: number }>;
}

export interface AMLAlertFilter {
  status?: AMLAlertStatus;
  userId?: string;
  startDate?: Date;
  endDate?: Date;
}

const defaultConfig: AMLConfig = {
  singleTransactionThresholdXaf: Number(
    process.env.AML_SINGLE_TRANSACTION_THRESHOLD_XAF || 1_000_000,
  ),
  dailyTotalThresholdXaf: Number(
    process.env.AML_DAILY_TOTAL_THRESHOLD_XAF || 5_000_000,
  ),
  rollingWindowHours: Number(process.env.AML_ROLLING_WINDOW_HOURS || 24),
  rapidWindowMinutes: Number(process.env.AML_RAPID_WINDOW_MINUTES || 15),
  rapidTransactionCount: Number(process.env.AML_RAPID_TRANSACTION_COUNT || 3),
  structuringFloorXaf: Number(process.env.AML_STRUCTURING_FLOOR_XAF || 100_000),
  alertBufferSize: Number(process.env.AML_ALERT_BUFFER_SIZE || 5000),
  profileScoreThreshold: Number(process.env.AML_PROFILE_SCORE_THRESHOLD || 50),
  velocityHourlyCap: Number(process.env.AML_VELOCITY_HOURLY_CAP || 5),
  velocityDailyCap: Number(process.env.AML_VELOCITY_DAILY_CAP || 15),
  movingAverageWindowDays: Number(process.env.AML_MOVING_AVERAGE_WINDOW_DAYS || 30),
  amountMultiplierLimit: Number(process.env.AML_AMOUNT_MULTIPLIER_LIMIT || 3),
  frequencySpikeMultiplier: Number(process.env.AML_FREQUENCY_SPIKE_MULTIPLIER || 3),
  geoHopMaxKm: Number(process.env.AML_GEO_HOP_MAX_KM || 250),
  geoHopMaxHours: Number(process.env.AML_GEO_HOP_MAX_HOURS || 6),
};

const PROFILE_SCORE_WEIGHTS = {
  amountAnomaly: 30,
  hourlyVelocity: 25,
  dailyVelocity: 25,
  frequencySpike: 20,
  geographicHop: 25,
} as const;

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function safeDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeLocationMetadata(
  value: Record<string, unknown> | null | undefined,
): AMLTransactionLocation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const status = typeof value.status === "string" ? value.status : null;
  if (status && status !== "resolved") {
    return null;
  }

  const lat = toFiniteNumber(value.lat);
  const lng = toFiniteNumber(value.lng ?? value.lon);
  if (lat === null || lng === null) {
    return null;
  }

  return { lat, lng };
}

export class AMLService {
  private readonly config: AMLConfig;
  private alerts: AMLAlert[] = [];

  constructor(config?: Partial<AMLConfig>) {
    this.config = { ...defaultConfig, ...config };
  }

  getConfig(): AMLConfig {
    return { ...this.config };
  }

  getLookbackWindowStart(now: Date): Date {
    return new Date(
      now.getTime() - this.config.rollingWindowHours * 60 * 60 * 1000,
    );
  }

  private getRapidWindowStart(now: Date): Date {
    return new Date(now.getTime() - this.config.rapidWindowMinutes * 60 * 1000);
  }

  async fetchRecentTransactions(
    userId: string,
    since: Date,
    excludeTransactionId?: string,
  ): Promise<AMLTransactionRecord[]> {
    const query = `
      SELECT
        id,
        user_id AS "userId",
        type,
        amount::text AS amount,
        status,
        location_metadata AS "locationMetadata",
        created_at AS "createdAt"
      FROM transactions
      WHERE user_id = $1
        AND created_at >= $2
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      ORDER BY created_at DESC
    `;

    const result = await pool.query<{
      id: string;
      userId: string;
      type: AMLTransactionType;
      amount: string;
      status: string;
      locationMetadata: Record<string, unknown> | null;
      createdAt: Date;
    }>(query, [userId, since, excludeTransactionId ?? null]);

    return result.rows
      .map((row) => ({
        id: row.id,
        userId: row.userId,
        type: row.type,
        amount: Number(row.amount),
        status: row.status,
        locationMetadata: row.locationMetadata,
        createdAt: safeDate(row.createdAt),
      }))
      .filter((row) => Number.isFinite(row.amount) && row.amount >= 0);
  }

  private async fetchUserName(userId: string): Promise<string | null> {
    const query = `
      SELECT applicant_data->>'first_name' as "firstName", applicant_data->>'last_name' as "lastName"
      FROM kyc_applicants
      WHERE user_id = $1
      LIMIT 1
    `;
    try {
      const result = await pool.query<{ firstName: string; lastName: string }>(
        query,
        [userId],
      );
      if (result.rows.length === 0) return null;
      const { firstName, lastName } = result.rows[0];
      return `${firstName || ""} ${lastName || ""}`.trim();
    } catch (error) {
      console.error(`Failed to fetch user name for AML: ${error}`);
      return null;
    }
  }

  private buildDynamicProfileResult(
    current: AMLTransactionRecord,
    snapshot: CachedAmlProfileSnapshot,
  ): AMLMonitoringResult {
    const reasons: string[] = [];
    let riskScore = 0;

    const movingAverageAmount =
      snapshot.movingAverageAmount > 0
        ? snapshot.movingAverageAmount
        : current.amount;
    const amountVsAverageRatio =
      movingAverageAmount > 0 ? current.amount / movingAverageAmount : 1;

    const projectedHourlyCount = snapshot.countLastHour + 1;
    const projectedDailyCount = snapshot.countLast24Hours + 1;
    const hourlyVelocityRatio =
      this.config.velocityHourlyCap > 0
        ? projectedHourlyCount / this.config.velocityHourlyCap
        : 0;
    const dailyVelocityRatio =
      this.config.velocityDailyCap > 0
        ? projectedDailyCount / this.config.velocityDailyCap
        : 0;

    const averageDailyCount = snapshot.countLast7Days / 7;
    const frequencySpikeRatio =
      averageDailyCount > 0 ? projectedDailyCount / averageDailyCount : 0;

    let geographicHopDistanceKm: number | null = null;
    let geographicHopHours: number | null = null;

    if (
      snapshot.historicalCount >= 3 &&
      amountVsAverageRatio >= this.config.amountMultiplierLimit
    ) {
      riskScore += PROFILE_SCORE_WEIGHTS.amountAnomaly;
      reasons.push(
        `Amount ${current.amount} XAF is ${amountVsAverageRatio.toFixed(1)}x the recent moving average of ${movingAverageAmount.toFixed(0)} XAF`,
      );
    }

    if (
      this.config.velocityHourlyCap > 0 &&
      projectedHourlyCount > this.config.velocityHourlyCap
    ) {
      riskScore += PROFILE_SCORE_WEIGHTS.hourlyVelocity;
      reasons.push(
        `Projected hourly velocity ${projectedHourlyCount} exceeds AML cap ${this.config.velocityHourlyCap}`,
      );
    }

    if (
      this.config.velocityDailyCap > 0 &&
      projectedDailyCount > this.config.velocityDailyCap
    ) {
      riskScore += PROFILE_SCORE_WEIGHTS.dailyVelocity;
      reasons.push(
        `Projected 24h velocity ${projectedDailyCount} exceeds AML cap ${this.config.velocityDailyCap}`,
      );
    }

    if (
      snapshot.historicalCount >= 5 &&
      averageDailyCount >= 1 &&
      frequencySpikeRatio >= this.config.frequencySpikeMultiplier
    ) {
      riskScore += PROFILE_SCORE_WEIGHTS.frequencySpike;
      reasons.push(
        `Recent transaction frequency is ${frequencySpikeRatio.toFixed(1)}x the user's 7-day daily average`,
      );
    }

    const currentLocation = normalizeLocationMetadata(current.locationMetadata);
    const lastLocation = normalizeLocationMetadata(snapshot.lastLocationMetadata);
    if (currentLocation && lastLocation && snapshot.lastLocationAt) {
      geographicHopDistanceKm = getDistanceKm(lastLocation, currentLocation);
      geographicHopHours =
        (current.createdAt.getTime() - snapshot.lastLocationAt.getTime()) /
        (60 * 60 * 1000);

      if (
        geographicHopDistanceKm > this.config.geoHopMaxKm &&
        geographicHopHours <= this.config.geoHopMaxHours
      ) {
        riskScore += PROFILE_SCORE_WEIGHTS.geographicHop;
        reasons.push(
          `Geographic hop of ${geographicHopDistanceKm.toFixed(0)}km within ${geographicHopHours.toFixed(1)}h exceeds AML hop limits`,
        );
      }
    }

    const profile: AMLRiskProfile = {
      historicalCount: snapshot.historicalCount,
      countLastHour: projectedHourlyCount,
      countLast24Hours: projectedDailyCount,
      countLast7Days: snapshot.countLast7Days,
      movingAverageAmount,
      amountVsAverageRatio,
      hourlyVelocityRatio,
      dailyVelocityRatio,
      averageDailyCount,
      frequencySpikeRatio,
      geographicHopDistanceKm,
      geographicHopHours,
    };

    const flagged = riskScore >= this.config.profileScoreThreshold;
    const ruleHits = flagged
      ? [
          {
            rule: "dynamic_profile_score" as const,
            message: `Dynamic AML profile score ${riskScore} exceeds threshold ${this.config.profileScoreThreshold}`,
            observed: riskScore,
            threshold: this.config.profileScoreThreshold,
          },
        ]
      : [];

    const summaryReasons = flagged
      ? [ruleHits[0].message, ...reasons]
      : reasons;

    return {
      flagged,
      ruleHits,
      riskScore,
      scoreThreshold: this.config.profileScoreThreshold,
      recommendedAction: flagged ? "review" : "allow",
      reasons: summaryReasons,
      profile,
    };
  }

  async profileTransaction(
    transaction: AMLTransactionRecord,
  ): Promise<AMLMonitoringResult> {
    const snapshot = await getCachedAmlProfileSnapshot(
      transaction.userId,
      transaction.createdAt,
      {
        excludeTransactionId: transaction.id,
        movingAverageWindowDays: this.config.movingAverageWindowDays,
      },
    );

    return this.buildDynamicProfileResult(transaction, snapshot);
  }

  async evaluateProfileTransaction(
    current: AMLTransactionRecord,
    snapshot: CachedAmlProfileSnapshot,
  ): Promise<AMLMonitoringResult> {
    return this.buildDynamicProfileResult(current, snapshot);
  }

  async evaluateTransaction(
    current: AMLTransactionRecord,
    recentTransactions: AMLTransactionRecord[],
  ): Promise<AMLMonitoringResult> {
    const ruleHits: AMLRuleHit[] = [];
    const lookbackStart = this.getLookbackWindowStart(current.createdAt);
    const windowTxs = recentTransactions.filter(
      (tx) => tx.createdAt >= lookbackStart,
    );

    if (current.amount > this.config.singleTransactionThresholdXaf) {
      ruleHits.push({
        rule: "single_transaction_threshold",
        message: `Single transaction amount ${current.amount} XAF exceeds ${this.config.singleTransactionThresholdXaf} XAF`,
        observed: current.amount,
        threshold: this.config.singleTransactionThresholdXaf,
      });
    }

    const rollingTotal =
      windowTxs.reduce((sum, tx) => sum + tx.amount, 0) + current.amount;
    if (rollingTotal > this.config.dailyTotalThresholdXaf) {
      ruleHits.push({
        rule: "daily_total_threshold",
        message: `Rolling 24h total ${rollingTotal} XAF exceeds ${this.config.dailyTotalThresholdXaf} XAF`,
        observed: rollingTotal,
        threshold: this.config.dailyTotalThresholdXaf,
      });
    }

    const rapidWindowStart = this.getRapidWindowStart(current.createdAt);
    const rapidWindowTxs = windowTxs.filter(
      (tx) => tx.createdAt >= rapidWindowStart,
    );
    const rapidSet = [...rapidWindowTxs, current];
    const rapidCount = rapidSet.length;
    const hasDeposit = rapidSet.some((tx) => tx.type === "deposit");
    const hasWithdraw = rapidSet.some((tx) => tx.type === "withdraw");
    const structuringTxs = rapidSet.filter(
      (tx) =>
        tx.amount >= this.config.structuringFloorXaf &&
        tx.amount < this.config.singleTransactionThresholdXaf,
    );

    if (
      rapidCount >= this.config.rapidTransactionCount &&
      hasDeposit &&
      hasWithdraw &&
      structuringTxs.length >= this.config.rapidTransactionCount
    ) {
      ruleHits.push({
        rule: "rapid_structuring",
        message: `Rapid in/out pattern detected (${rapidCount} tx in ${this.config.rapidWindowMinutes}m)`,
        observed: rapidCount,
        threshold: this.config.rapidTransactionCount,
      });
    }

    if (ruleHits.length === 0) {
      return {
        flagged: false,
        ruleHits: [],
        riskScore: 0,
        scoreThreshold: this.config.profileScoreThreshold,
        recommendedAction: "allow",
        reasons: [],
      };
    }

    const severity: AMLAlertSeverity = ruleHits.some(
      (hit) =>
        hit.rule === "single_transaction_threshold" ||
        hit.rule === "daily_total_threshold",
    )
      ? "high"
      : "medium";

    const nowIso = new Date().toISOString();
    const alert: AMLAlert = {
      id: crypto.randomUUID(),
      transactionId: current.id,
      userId: current.userId,
      severity,
      status: "pending_review",
      ruleHits,
      reasons: ruleHits.map((hit) => hit.message),
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await this.recordAlert(alert);
    this.logAlert(alert, current);

    return {
      flagged: true,
      alert,
      ruleHits,
      riskScore: this.config.profileScoreThreshold,
      scoreThreshold: this.config.profileScoreThreshold,
      recommendedAction: "review",
      reasons: alert.reasons,
    };
  }

  async monitorTransaction(
    transaction: AMLTransactionRecord,
  ): Promise<AMLMonitoringResult> {
    const since = this.getLookbackWindowStart(transaction.createdAt);
    const [recent, userName] = await Promise.all([
      this.fetchRecentTransactions(transaction.userId, since, transaction.id),
      this.fetchUserName(transaction.userId),
    ]);

    const result = await this.evaluateTransaction(transaction, recent);

    if (userName) {
      const sanctionMatches = await sanctionService.searchSanctions(userName);
      if (sanctionMatches.length > 0) {
        const topMatch = sanctionMatches[0];
        const sanctionHit: AMLRuleHit = {
          rule: "sanction_match",
          message: `Potential sanction match: "${topMatch.entity.name}" (Score: ${topMatch.score.toFixed(2)}) from ${topMatch.entity.source}`,
          observed: topMatch.score,
          threshold: 0.85,
        };

        result.flagged = true;
        result.ruleHits.push(sanctionHit);
        result.reasons.push(sanctionHit.message);
        result.recommendedAction = "review";

        if (!result.alert) {
          const nowIso = new Date().toISOString();
          result.alert = {
            id: crypto.randomUUID(),
            transactionId: transaction.id,
            userId: transaction.userId,
            severity: "high",
            status: "pending_review",
            ruleHits: [sanctionHit],
            reasons: [sanctionHit.message],
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          await this.recordAlert(result.alert);
        } else {
          result.alert.severity = "high";
          result.alert.ruleHits.push(sanctionHit);
          result.alert.reasons.push(sanctionHit.message);
        }
      }
    }

    if (result.flagged && result.alert) {
      this.logAlert(result.alert, transaction);
    }

    return result;
  }

  getAlerts(filter?: AMLAlertFilter): AMLAlert[] {
    const startMs = filter?.startDate?.getTime() ?? Number.NEGATIVE_INFINITY;
    const endMs = filter?.endDate?.getTime() ?? Number.POSITIVE_INFINITY;

    return this.alerts
      .filter((alert) => {
        if (filter?.status && alert.status !== filter.status) return false;
        if (filter?.userId && alert.userId !== filter.userId) return false;
        const ts = safeDate(alert.createdAt).getTime();
        return ts >= startMs && ts <= endMs;
      })
      .sort(
        (a, b) =>
          safeDate(b.createdAt).getTime() - safeDate(a.createdAt).getTime(),
      );
  }

  getPendingReviewAlerts(): AMLAlert[] {
    return this.getAlerts({ status: "pending_review" });
  }

  reviewAlert(alertId: string, input: AMLReviewInput): AMLAlert | null {
    const idx = this.alerts.findIndex((alert) => alert.id === alertId);
    if (idx === -1) return null;

    const nowIso = new Date().toISOString();
    const updated: AMLAlert = {
      ...this.alerts[idx],
      status: input.status,
      reviewedBy: input.reviewedBy,
      reviewNotes: input.reviewNotes,
      reviewedAt: nowIso,
      updatedAt: nowIso,
    };
    this.alerts[idx] = updated;
    return updated;
  }

  generateReport(startDate: Date, endDate: Date): AMLReport {
    const alerts = this.getAlerts({ startDate, endDate });
    const summary = {
      totalAlerts: alerts.length,
      pendingReview: alerts.filter((a) => a.status === "pending_review").length,
      reviewed: alerts.filter((a) => a.status === "reviewed").length,
      dismissed: alerts.filter((a) => a.status === "dismissed").length,
      highSeverity: alerts.filter((a) => a.severity === "high").length,
      mediumSeverity: alerts.filter((a) => a.severity === "medium").length,
    };

    const byRule: Record<AMLRule, number> = {
      single_transaction_threshold: 0,
      daily_total_threshold: 0,
      rapid_structuring: 0,
      sanction_match: 0,
      dynamic_profile_score: 0,
    };

    const dailyMap = new Map<string, number>();
    for (const alert of alerts) {
      for (const hit of alert.ruleHits) {
        byRule[hit.rule] += 1;
      }
      const key = toISODate(safeDate(alert.createdAt));
      dailyMap.set(key, (dailyMap.get(key) ?? 0) + 1);
    }

    const daily = Array.from(dailyMap.entries())
      .map(([date, count]) => ({ date, alerts: count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      period: { start: toISODate(startDate), end: toISODate(endDate) },
      summary,
      byRule,
      daily,
    };
  }

  clearAlerts(): void {
    this.alerts = [];
  }

  private async recordAlert(alert: AMLAlert): Promise<void> {
    try {
      const { AMLAlertModel } = await import("../models/amlAlert.js");
      const model = new AMLAlertModel();
      await model.create(alert);

      if (alert.severity === "high") {
        console.log(
          `[SAR AUTO-PREPARE] High severity alert ${alert.id} detected. Preparing SAR...`,
        );
        try {
          const { generateSAR } = require("../compliance/sar");
          generateSAR(alert.userId, alert.id).catch((err: any) => {
            console.error(
              `[SAR AUTO-PREPARE ERROR] Failed for alert ${alert.id}:`,
              err,
            );
          });
        } catch (err) {
          console.error(
            `[SAR AUTO-PREPARE ERROR] Failed to load sar service:`,
            err,
          );
        }
      }
    } catch (error) {
      console.error("Failed to persist AML alert to database:", error);
      this.alerts.unshift(alert);
      if (this.alerts.length > this.config.alertBufferSize) {
        this.alerts = this.alerts.slice(0, this.config.alertBufferSize);
      }
    }
  }

  private logAlert(alert: AMLAlert, transaction: AMLTransactionRecord): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "WARN",
      type: "AML_ALERT",
      alertId: alert.id,
      transactionId: alert.transactionId,
      userId: alert.userId,
      severity: alert.severity,
      amount: transaction.amount,
      rules: alert.ruleHits.map((hit) => hit.rule),
      reasons: alert.reasons,
    });
    console.warn(line);
  }
}

export const amlService = new AMLService();
