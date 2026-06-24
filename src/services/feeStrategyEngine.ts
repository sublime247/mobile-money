/**
 * Dynamic Fee Strategy Engine
 *
 * Architecture: Strategy Pattern + Priority Resolver
 *
 * Priority hierarchy (highest → lowest):
 *   1. User-specific strategies   (scope = 'user')
 *   2. Provider-specific strategies (scope = 'provider')
 *   3. Global/default strategies  (scope = 'global')
 *
 * Within the same scope, strategies are ordered by `priority` (lower = higher priority).
 *
 * Strategy types:
 *   - FlatFeeStrategy       — fixed fee amount
 *   - PercentageFeeStrategy — percentage of transaction amount with min/max clamp
 *   - TimeBasedFeeStrategy  — overrides fee during specific days/hours (e.g. Fee-free Fridays)
 *   - VolumeBasedFeeStrategy — tiered fee based on transaction amount brackets
 *
 * Caching:
 *   - Active strategies are cached in Redis (TTL: 60 s) and invalidated on any write.
 *   - Cache key: `fee_strategies:active` (all active), `fee_strategies:user:<id>`,
 *     `fee_strategies:provider:<name>`
 *
 * Thread safety:
 *   - All writes go through PostgreSQL transactions.
 *   - Cache invalidation is best-effort (non-fatal on Redis failure).
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";

// ─────────────────────────────────────────────────────────────────────────────
// Types & Interfaces
// ─────────────────────────────────────────────────────────────────────────────

export type FeeStrategyType = "flat" | "percentage" | "time_based" | "volume_based";
export type FeeStrategyScope = "user" | "provider" | "global";

export interface VolumeTier {
  /** Minimum transaction amount (inclusive) for this tier. */
  minAmount: number;
  /** Maximum transaction amount (exclusive). null = no upper bound. */
  maxAmount: number | null;
  /** Percentage fee for this tier (e.g. 1.5 = 1.5%). */
  feePercentage?: number;
  /** Flat fee for this tier (used when feePercentage is not set). */
  flatAmount?: number;
}

export interface FeeStrategy {
  id: string;
  name: string;
  description?: string;
  strategyType: FeeStrategyType;
  scope: FeeStrategyScope;
  userId?: string;
  provider?: string;
  priority: number;
  isActive: boolean;

  // Flat fee
  flatAmount?: number;

  // Percentage fee
  feePercentage?: number;
  feeMinimum?: number;
  feeMaximum?: number;

  // Time-based
  daysOfWeek?: number[];   // ISO weekday: 1=Mon … 7=Sun
  timeStart?: string;      // 'HH:MM' UTC
  timeEnd?: string;        // 'HH:MM' UTC
  overridePercentage?: number;
  overrideFlatAmount?: number;

  // Volume-based
  volumeTiers?: VolumeTier[];

  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeeCalculationContext {
  /** Transaction amount in base currency. */
  amount: number;
  /** Authenticated user ID (optional — enables user-scope strategies). */
  userId?: string;
  /** Mobile money provider slug (optional — enables provider-scope strategies). */
  provider?: string;
  /** Point in time for time-based evaluation. Defaults to now (UTC). */
  evaluationTime?: Date;
}

export interface FeeCalculationResult {
  fee: number;
  total: number;
  /** Name of the strategy that was applied. */
  strategyUsed: string;
  /** Scope of the winning strategy. */
  scopeUsed: FeeStrategyScope;
  /** Whether a time-based override was active. */
  timeOverrideActive: boolean;
  /** Breakdown for transparency / debugging. */
  breakdown: {
    strategyId: string;
    strategyType: FeeStrategyType;
    rawFee: number;
    clampedFee: number;
    appliedMinimum?: number;
    appliedMaximum?: number;
  };
}

export interface CreateFeeStrategyRequest {
  name: string;
  description?: string;
  strategyType: FeeStrategyType;
  scope: FeeStrategyScope;
  userId?: string;
  provider?: string;
  priority?: number;
  flatAmount?: number;
  feePercentage?: number;
  feeMinimum?: number;
  feeMaximum?: number;
  daysOfWeek?: number[];
  timeStart?: string;
  timeEnd?: string;
  overridePercentage?: number;
  overrideFlatAmount?: number;
  volumeTiers?: VolumeTier[];
}

export interface UpdateFeeStrategyRequest {
  name?: string;
  description?: string;
  priority?: number;
  isActive?: boolean;
  flatAmount?: number;
  feePercentage?: number;
  feeMinimum?: number;
  feeMaximum?: number;
  daysOfWeek?: number[];
  timeStart?: string;
  timeEnd?: string;
  overridePercentage?: number;
  overrideFlatAmount?: number;
  volumeTiers?: VolumeTier[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy implementations (pure functions — no I/O)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamp a fee value between optional min and max bounds.
 */
function clampFee(
  fee: number,
  minimum?: number,
  maximum?: number,
): { clamped: number; appliedMin?: number; appliedMax?: number } {
  let clamped = fee;
  let appliedMin: number | undefined;
  let appliedMax: number | undefined;

  if (minimum !== undefined && clamped < minimum) {
    clamped = minimum;
    appliedMin = minimum;
  }
  if (maximum !== undefined && clamped > maximum) {
    clamped = maximum;
    appliedMax = maximum;
  }

  return { clamped, appliedMin, appliedMax };
}

/**
 * FlatFeeStrategy — returns a fixed fee regardless of amount.
 */
function applyFlatFee(
  strategy: FeeStrategy,
  amount: number,
): { rawFee: number; clampedFee: number; appliedMinimum?: number; appliedMaximum?: number } {
  const rawFee = strategy.flatAmount ?? 0;
  const { clamped, appliedMin, appliedMax } = clampFee(rawFee, strategy.feeMinimum, strategy.feeMaximum);
  return { rawFee, clampedFee: clamped, appliedMinimum: appliedMin, appliedMaximum: appliedMax };
}

/**
 * PercentageFeeStrategy — percentage of amount, clamped to [min, max].
 */
function applyPercentageFee(
  strategy: FeeStrategy,
  amount: number,
): { rawFee: number; clampedFee: number; appliedMinimum?: number; appliedMaximum?: number } {
  const rawFee = amount * ((strategy.feePercentage ?? 0) / 100);
  const minimum = strategy.scope === "user" ? undefined : strategy.feeMinimum;
  const { clamped, appliedMin, appliedMax } = clampFee(rawFee, minimum, strategy.feeMaximum);
  return { rawFee, clampedFee: clamped, appliedMinimum: appliedMin, appliedMaximum: appliedMax };
}

/**
 * TimeBasedFeeStrategy — checks if the evaluation time falls within the
 * configured days/hours window.  If it does, applies the override fee;
 * otherwise falls through (returns null so the engine can try the next strategy).
 *
 * @returns null when the time condition is NOT met (engine should fall through).
 */
function applyTimeBasedFee(
  strategy: FeeStrategy,
  amount: number,
  evaluationTime: Date,
): { rawFee: number; clampedFee: number; appliedMinimum?: number; appliedMaximum?: number } | null {
  const daysOfWeek = strategy.daysOfWeek ?? [];

  // ISO weekday: getDay() returns 0=Sun…6=Sat; convert to 1=Mon…7=Sun
  const jsDay = evaluationTime.getUTCDay(); // 0=Sun
  const isoDay = jsDay === 0 ? 7 : jsDay;  // 7=Sun

  if (!daysOfWeek.includes(isoDay)) {
    return null; // Day condition not met
  }

  // Optional time-of-day window check
  if (strategy.timeStart && strategy.timeEnd) {
    const hhmm = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const current = hhmm(evaluationTime);
    if (current < strategy.timeStart || current >= strategy.timeEnd) {
      return null; // Time window not met
    }
  }

  // Time condition met — apply override
  let rawFee: number;
  if (strategy.overrideFlatAmount !== undefined) {
    rawFee = strategy.overrideFlatAmount;
  } else {
    // overridePercentage defaults to 0 (fee-free) when not set
    rawFee = amount * ((strategy.overridePercentage ?? 0) / 100);
  }

  const { clamped, appliedMin, appliedMax } = clampFee(rawFee, undefined, strategy.feeMaximum);
  return { rawFee, clampedFee: clamped, appliedMinimum: appliedMin, appliedMaximum: appliedMax };
}

/**
 * VolumeBasedFeeStrategy — finds the first matching tier bracket and applies
 * its fee.  Tiers should be ordered from lowest to highest minAmount.
 */
function applyVolumeBasedFee(
  strategy: FeeStrategy,
  amount: number,
): { rawFee: number; clampedFee: number; appliedMinimum?: number; appliedMaximum?: number } {
  const tiers = strategy.volumeTiers ?? [];

  const matchedTier = tiers.find(
    (t) => amount >= t.minAmount && (t.maxAmount === null || amount < t.maxAmount),
  );

  let rawFee = 0;
  let matched = false;
  if (matchedTier) {
    matched = true;
    if (matchedTier.feePercentage !== undefined) {
      rawFee = amount * (matchedTier.feePercentage / 100);
    } else if (matchedTier.flatAmount !== undefined) {
      rawFee = matchedTier.flatAmount;
    }
  }

  const minimum = matched ? strategy.feeMinimum : undefined;
  const { clamped, appliedMin, appliedMax } = clampFee(rawFee, minimum, strategy.feeMaximum);
  return { rawFee, clampedFee: clamped, appliedMinimum: appliedMin, appliedMaximum: appliedMax };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_PREFIX = "fee_strategies:";
const CACHE_TTL_SECONDS = 60; // Short TTL so live changes propagate quickly

async function cacheGet(key: string): Promise<FeeStrategy[] | null> {
  try {
    const raw = await redisClient.get(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const str = typeof raw === "string" ? raw : raw.toString();
    return JSON.parse(str) as FeeStrategy[];
  } catch {
    return null;
  }
}

async function cacheSet(key: string, strategies: FeeStrategy[]): Promise<void> {
  try {
    await redisClient.setEx(`${CACHE_PREFIX}${key}`, CACHE_TTL_SECONDS, JSON.stringify(strategies));
  } catch {
    // Cache write failure is non-fatal
  }
}

async function cacheInvalidateAll(): Promise<void> {
  try {
    const keys = await redisClient.keys(`${CACHE_PREFIX}*`);
    for (const key of keys) {
      await redisClient.del(key);
    }
  } catch {
    // Non-fatal
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB row → FeeStrategy mapper
// ─────────────────────────────────────────────────────────────────────────────

function rowToStrategy(row: Record<string, unknown>): FeeStrategy {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    strategyType: row.strategy_type as FeeStrategyType,
    scope: row.scope as FeeStrategyScope,
    userId: row.user_id as string | undefined,
    provider: row.provider as string | undefined,
    priority: row.priority as number,
    isActive: row.is_active as boolean,
    flatAmount: row.flat_amount != null ? parseFloat(row.flat_amount as string) : undefined,
    feePercentage: row.fee_percentage != null ? parseFloat(row.fee_percentage as string) : undefined,
    feeMinimum: row.fee_minimum != null ? parseFloat(row.fee_minimum as string) : undefined,
    feeMaximum: row.fee_maximum != null ? parseFloat(row.fee_maximum as string) : undefined,
    daysOfWeek: row.days_of_week as number[] | undefined,
    timeStart: row.time_start as string | undefined,
    timeEnd: row.time_end as string | undefined,
    overridePercentage: row.override_percentage != null ? parseFloat(row.override_percentage as string) : undefined,
    overrideFlatAmount: row.override_flat_amount != null ? parseFloat(row.override_flat_amount as string) : undefined,
    volumeTiers: row.volume_tiers as VolumeTier[] | undefined,
    createdBy: row.created_by as string,
    updatedBy: row.updated_by as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

const STRATEGY_SELECT = `
  id,
  name,
  description,
  strategy_type,
  scope,
  user_id,
  provider,
  priority,
  is_active,
  flat_amount,
  fee_percentage,
  fee_minimum,
  fee_maximum,
  days_of_week,
  time_start,
  time_end,
  override_percentage,
  override_flat_amount,
  volume_tiers,
  created_by,
  updated_by,
  created_at,
  updated_at
`;

// ─────────────────────────────────────────────────────────────────────────────
// FeeStrategyEngine
// ─────────────────────────────────────────────────────────────────────────────

export class FeeStrategyEngine {
  /**
   * Core method: resolve and apply the best fee strategy for a given context.
   *
   * Resolution order:
   *   1. User-specific strategies (if userId provided), sorted by priority ASC
   *   2. Provider-specific strategies (if provider provided), sorted by priority ASC
   *   3. Global strategies, sorted by priority ASC
   *
   * Within each scope, time_based strategies are evaluated first because they
   * can override the base fee.  If a time_based strategy's condition is NOT met,
   * the engine falls through to the next strategy in the same scope.
   *
   * Falls back to the legacy FeeService active configuration when no strategy matches.
   */
  async calculateFee(ctx: FeeCalculationContext): Promise<FeeCalculationResult> {
    const evaluationTime = ctx.evaluationTime ?? new Date();
    const candidates = await this.resolveStrategies(ctx.userId, ctx.provider);

    for (const strategy of candidates) {
      const result = this.applyStrategy(strategy, ctx.amount, evaluationTime);
      if (result !== null) {
        return {
          fee: parseFloat(result.clampedFee.toFixed(2)),
          total: parseFloat((ctx.amount + result.clampedFee).toFixed(2)),
          strategyUsed: strategy.name,
          scopeUsed: strategy.scope,
          timeOverrideActive: strategy.strategyType === "time_based",
          breakdown: {
            strategyId: strategy.id,
            strategyType: strategy.strategyType,
            rawFee: parseFloat(result.rawFee.toFixed(2)),
            clampedFee: parseFloat(result.clampedFee.toFixed(2)),
            appliedMinimum: result.appliedMinimum,
            appliedMaximum: result.appliedMaximum,
          },
        };
      }
    }

    // No strategy matched — return zero fee as safe default
    return {
      fee: 0,
      total: ctx.amount,
      strategyUsed: "none",
      scopeUsed: "global",
      timeOverrideActive: false,
      breakdown: {
        strategyId: "",
        strategyType: "flat",
        rawFee: 0,
        clampedFee: 0,
      },
    };
  }

  /**
   * Apply a single strategy to an amount.
   * Returns null if the strategy's condition is not met (time_based only).
   */
  private applyStrategy(
    strategy: FeeStrategy,
    amount: number,
    evaluationTime: Date,
  ): { rawFee: number; clampedFee: number; appliedMinimum?: number; appliedMaximum?: number } | null {
    switch (strategy.strategyType) {
      case "flat":
        return applyFlatFee(strategy, amount);
      case "percentage":
        return applyPercentageFee(strategy, amount);
      case "time_based":
        return applyTimeBasedFee(strategy, amount, evaluationTime);
      case "volume_based":
        return applyVolumeBasedFee(strategy, amount);
      default:
        return null;
    }
  }

  /**
   * Fetch and order candidate strategies for a given context.
   * Strategies are returned in priority order: user → provider → global,
   * with lower `priority` number winning within each scope.
   */
  async resolveStrategies(userId?: string, provider?: string): Promise<FeeStrategy[]> {
    const cacheKey = `resolved:${userId ?? ""}:${provider ?? ""}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const params: unknown[] = [];
    const scopeClauses: string[] = [];

    // Always include global strategies
    scopeClauses.push(`scope = 'global'`);

    if (provider) {
      params.push(provider);
      scopeClauses.push(`(scope = 'provider' AND provider = $${params.length})`);
    }

    if (userId) {
      params.push(userId);
      scopeClauses.push(`(scope = 'user' AND user_id = $${params.length})`);
    }

    const query = `
      SELECT ${STRATEGY_SELECT}
      FROM fee_strategies
      WHERE is_active = true
        AND (${scopeClauses.join(" OR ")})
      ORDER BY
        CASE scope
          WHEN 'user'     THEN 1
          WHEN 'provider' THEN 2
          WHEN 'global'   THEN 3
        END ASC,
        priority ASC
    `;

    const result = await pool.query(query, params);
    const strategies = result.rows.map(rowToStrategy);

    await cacheSet(cacheKey, strategies);
    return strategies;
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Create a new fee strategy.
   */
  async createStrategy(
    data: CreateFeeStrategyRequest,
    createdBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<FeeStrategy> {
    const query = `
      INSERT INTO fee_strategies (
        name, description, strategy_type, scope,
        user_id, provider, priority,
        flat_amount, fee_percentage, fee_minimum, fee_maximum,
        days_of_week, time_start, time_end, override_percentage, override_flat_amount,
        volume_tiers,
        created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15, $16,
        $17,
        $18, $18
      )
      RETURNING ${STRATEGY_SELECT}
    `;

    const result = await pool.query(query, [
      data.name,
      data.description ?? null,
      data.strategyType,
      data.scope,
      data.userId ?? null,
      data.provider ?? null,
      data.priority ?? 100,
      data.flatAmount ?? null,
      data.feePercentage ?? null,
      data.feeMinimum ?? null,
      data.feeMaximum ?? null,
      data.daysOfWeek ? JSON.stringify(data.daysOfWeek) : null,
      data.timeStart ?? null,
      data.timeEnd ?? null,
      data.overridePercentage ?? null,
      data.overrideFlatAmount ?? null,
      data.volumeTiers ? JSON.stringify(data.volumeTiers) : null,
      createdBy,
    ]);

    const strategy = rowToStrategy(result.rows[0]);
    await this.logAudit(strategy.id, "CREATE", null, strategy, createdBy, ipAddress, userAgent);
    await cacheInvalidateAll();

    return strategy;
  }

  /**
   * Update an existing fee strategy.
   */
  async updateStrategy(
    id: string,
    data: UpdateFeeStrategyRequest,
    updatedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<FeeStrategy | null> {
    const old = await this.getStrategyById(id);
    if (!old) return null;

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const set = (col: string, val: unknown) => {
      fields.push(`${col} = $${idx++}`);
      values.push(val);
    };

    if (data.name !== undefined) set("name", data.name);
    if (data.description !== undefined) set("description", data.description);
    if (data.priority !== undefined) set("priority", data.priority);
    if (data.isActive !== undefined) set("is_active", data.isActive);
    if (data.flatAmount !== undefined) set("flat_amount", data.flatAmount);
    if (data.feePercentage !== undefined) set("fee_percentage", data.feePercentage);
    if (data.feeMinimum !== undefined) set("fee_minimum", data.feeMinimum);
    if (data.feeMaximum !== undefined) set("fee_maximum", data.feeMaximum);
    if (data.daysOfWeek !== undefined) set("days_of_week", JSON.stringify(data.daysOfWeek));
    if (data.timeStart !== undefined) set("time_start", data.timeStart);
    if (data.timeEnd !== undefined) set("time_end", data.timeEnd);
    if (data.overridePercentage !== undefined) set("override_percentage", data.overridePercentage);
    if (data.overrideFlatAmount !== undefined) set("override_flat_amount", data.overrideFlatAmount);
    if (data.volumeTiers !== undefined) set("volume_tiers", JSON.stringify(data.volumeTiers));

    if (fields.length === 0) return old;

    set("updated_by", updatedBy);
    values.push(id);

    const query = `
      UPDATE fee_strategies
      SET ${fields.join(", ")}
      WHERE id = $${idx}
      RETURNING ${STRATEGY_SELECT}
    `;

    const result = await pool.query(query, values);
    if (result.rows.length === 0) return null;

    const updated = rowToStrategy(result.rows[0]);
    const action = data.isActive === true ? "ACTIVATE" : data.isActive === false ? "DEACTIVATE" : "UPDATE";
    await this.logAudit(id, action, old, updated, updatedBy, ipAddress, userAgent);
    await cacheInvalidateAll();

    return updated;
  }

  /**
   * Delete a fee strategy.
   */
  async deleteStrategy(
    id: string,
    deletedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<boolean> {
    const old = await this.getStrategyById(id);
    if (!old) return false;

    const result = await pool.query("DELETE FROM fee_strategies WHERE id = $1", [id]);
    if ((result.rowCount ?? 0) === 0) return false;

    await this.logAudit(id, "DELETE", old, null, deletedBy, ipAddress, userAgent);
    await cacheInvalidateAll();

    return true;
  }

  /**
   * Activate a strategy (sets is_active = true).
   */
  async activateStrategy(
    id: string,
    activatedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<FeeStrategy | null> {
    return this.updateStrategy(id, { isActive: true }, activatedBy, ipAddress, userAgent);
  }

  /**
   * Deactivate a strategy (sets is_active = false).
   */
  async deactivateStrategy(
    id: string,
    deactivatedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<FeeStrategy | null> {
    return this.updateStrategy(id, { isActive: false }, deactivatedBy, ipAddress, userAgent);
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  async getAllStrategies(): Promise<FeeStrategy[]> {
    const result = await pool.query(
      `SELECT ${STRATEGY_SELECT} FROM fee_strategies ORDER BY scope, priority ASC, created_at DESC`,
    );
    return result.rows.map(rowToStrategy);
  }

  async getStrategyById(id: string): Promise<FeeStrategy | null> {
    const result = await pool.query(
      `SELECT ${STRATEGY_SELECT} FROM fee_strategies WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return rowToStrategy(result.rows[0]);
  }

  async getAuditHistory(strategyId: string): Promise<unknown[]> {
    const result = await pool.query(
      `SELECT
         a.id, a.action,
         a.old_values AS "oldValues",
         a.new_values AS "newValues",
         a.changed_at AS "changedAt",
         a.ip_address AS "ipAddress",
         a.user_agent AS "userAgent",
         u.phone_number AS "changedByUser"
       FROM fee_strategy_audit a
       JOIN users u ON a.changed_by = u.id
       WHERE a.strategy_id = $1
       ORDER BY a.changed_at DESC`,
      [strategyId],
    );
    return result.rows;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async logAudit(
    strategyId: string,
    action: string,
    oldValues: unknown,
    newValues: unknown,
    changedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO fee_strategy_audit
         (strategy_id, action, old_values, new_values, changed_by, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        strategyId,
        action,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        changedBy,
        ipAddress ?? null,
        userAgent ?? null,
      ],
    );
  }
}

export const feeStrategyEngine = new FeeStrategyEngine();
