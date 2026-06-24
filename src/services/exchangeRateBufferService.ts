/**
 * Exchange Rate Buffer Service
 *
 * Applies a configurable spread (margin) to exchange rates on a per-provider,
 * per-currency-pair basis. This protects against volatility losses by ensuring
 * the platform always converts at a rate that includes a safety buffer.
 *
 * Architecture:
 *   - Each provider+currency_pair has an independent buffer config
 *   - A wildcard provider ('*') serves as the global fallback
 *   - Supports two modes:
 *       • static  — fixed percentage buffer
 *       • dynamic — buffer auto-adjusts based on recent price volatility
 *   - Buffers are cached in-memory (60s TTL) for hot-path performance
 *
 * Integration points:
 *   - CurrencyService.convertWithBuffer() for internal conversions
 *   - SEP-38 rateProvider for anchor quotes
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import { findRange } from "../models/historicalPrice";
import logger from "../utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExchangeRateBuffer {
  id: string;
  provider: string;
  currencyPair: string;
  bufferPercent: number;
  minBufferPct: number;
  maxBufferPct: number;
  volatilityMode: "static" | "dynamic";
  isActive: boolean;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BufferedRate {
  /** The raw mid-market rate before any buffer */
  rawRate: number;
  /** The rate after buffer is applied (what the user sees) */
  bufferedRate: number;
  /** The buffer percentage that was applied */
  bufferApplied: number;
  /** Provider whose config was used */
  providerUsed: string;
  /** Currency pair */
  currencyPair: string;
  /** Whether this used a dynamic or static buffer */
  mode: "static" | "dynamic";
}

export interface CreateBufferRequest {
  provider: string;
  currencyPair: string;
  bufferPercent: number;
  minBufferPct?: number;
  maxBufferPct?: number;
  volatilityMode?: "static" | "dynamic";
}

export interface UpdateBufferRequest {
  bufferPercent?: number;
  minBufferPct?: number;
  maxBufferPct?: number;
  volatilityMode?: "static" | "dynamic";
  isActive?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_PREFIX = "erb:";
const CACHE_TTL = 60; // seconds

async function cacheGet(key: string): Promise<ExchangeRateBuffer | null> {
  try {
    if (!redisClient?.isOpen) return null;
    const raw = await redisClient.get(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    return JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: ExchangeRateBuffer): Promise<void> {
  try {
    if (!redisClient?.isOpen) return;
    await redisClient.setEx(`${CACHE_PREFIX}${key}`, CACHE_TTL, JSON.stringify(value));
  } catch {
    // Non-fatal
  }
}

async function cacheInvalidate(key: string): Promise<void> {
  try {
    if (!redisClient?.isOpen) return;
    await redisClient.del(`${CACHE_PREFIX}${key}`);
  } catch {
    // Non-fatal
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapper
// ─────────────────────────────────────────────────────────────────────────────

function mapRow(row: any): ExchangeRateBuffer {
  return {
    id: row.id,
    provider: row.provider,
    currencyPair: row.currency_pair,
    bufferPercent: parseFloat(row.buffer_percent),
    minBufferPct: parseFloat(row.min_buffer_pct),
    maxBufferPct: parseFloat(row.max_buffer_pct),
    volatilityMode: row.volatility_mode,
    isActive: row.is_active,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export class ExchangeRateBufferService {
  /**
   * Core method: apply the buffer to a raw exchange rate.
   *
   * Resolution order:
   *   1. Exact provider + currency pair match
   *   2. Wildcard provider ('*') + currency pair
   *   3. Fallback: 0% buffer (pass-through)
   *
   * For a "sell" direction (user sells local currency for USD/XLM),
   * the buffer is subtracted from the rate (user gets less).
   * For a "buy" direction (user buys local currency with USD/XLM),
   * the buffer is added to the rate (user pays more).
   */
  async applyBuffer(
    rawRate: number,
    provider: string,
    fromCurrency: string,
    toCurrency: string,
    direction: "sell" | "buy" = "sell",
  ): Promise<BufferedRate> {
    const pair = `${fromCurrency}_${toCurrency}`;
    const config = await this.resolveBuffer(provider, pair);

    let bufferPct = config?.bufferPercent ?? 0;
    const mode = config?.volatilityMode ?? "static";

    // Dynamic mode: compute volatility-adjusted buffer
    if (config && mode === "dynamic") {
      bufferPct = await this.computeDynamicBuffer(config, fromCurrency, toCurrency);
    }

    // Clamp to configured bounds
    if (config) {
      bufferPct = Math.max(config.minBufferPct, Math.min(config.maxBufferPct, bufferPct));
    }

    // Apply buffer based on direction
    // sell: user gets less → we divide by (1 + buffer)
    // buy:  user pays more → we multiply by (1 + buffer)
    const multiplier = 1 + bufferPct / 100;
    const bufferedRate =
      direction === "sell" ? rawRate / multiplier : rawRate * multiplier;

    return {
      rawRate,
      bufferedRate: Math.round(bufferedRate * 1e7) / 1e7,
      bufferApplied: bufferPct,
      providerUsed: config?.provider ?? "none",
      currencyPair: pair,
      mode,
    };
  }

  /**
   * Compute a dynamic buffer based on recent price volatility.
   * Uses the coefficient of variation (stddev / mean) of hourly prices
   * over the last 24 hours, scaled to a percentage.
   */
  private async computeDynamicBuffer(
    config: ExchangeRateBuffer,
    fromCurrency: string,
    toCurrency: string,
  ): Promise<number> {
    try {
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const snapshots = await findRange(
        fromCurrency as any,
        toCurrency as any,
        oneDayAgo,
        now,
      );

      if (!snapshots || snapshots.length < 2) {
        // Not enough data — fall back to static buffer
        return config.bufferPercent;
      }

      const prices = snapshots.map((s) => s.price);
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      const variance =
        prices.reduce((sum, p) => sum + (p - mean) ** 2, 0) / prices.length;
      const stddev = Math.sqrt(variance);
      const coefficientOfVariation = (stddev / mean) * 100;

      // Scale: use 2x the coefficient of variation as the buffer,
      // but respect configured min/max bounds
      const dynamicBuffer = coefficientOfVariation * 2;

      logger.info(
        `[ERB] Dynamic buffer for ${fromCurrency}/${toCurrency}: CV=${coefficientOfVariation.toFixed(3)}%, buffer=${dynamicBuffer.toFixed(3)}%`,
      );

      return dynamicBuffer;
    } catch (err) {
      logger.warn({ err }, "[ERB] Dynamic buffer computation failed, using static fallback");
      return config.bufferPercent;
    }
  }

  // ─── Resolution ────────────────────────────────────────────────────────────

  /**
   * Resolve the buffer config for a provider + pair.
   * Falls back to wildcard provider '*' if no exact match.
   */
  async resolveBuffer(
    provider: string,
    currencyPair: string,
  ): Promise<ExchangeRateBuffer | null> {
    // Try exact match first
    const exact = await this.getBufferConfig(provider, currencyPair);
    if (exact) return exact;

    // Try wildcard provider
    const wildcard = await this.getBufferConfig("*", currencyPair);
    if (wildcard) return wildcard;

    return null;
  }

  private async getBufferConfig(
    provider: string,
    currencyPair: string,
  ): Promise<ExchangeRateBuffer | null> {
    const cacheKey = `${provider}:${currencyPair}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const result = await pool.query(
      `SELECT * FROM exchange_rate_buffers
       WHERE provider = $1 AND currency_pair = $2 AND is_active = true
       LIMIT 1`,
      [provider, currencyPair],
    );

    if (result.rows.length === 0) return null;

    const config = mapRow(result.rows[0]);
    await cacheSet(cacheKey, config);
    return config;
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  async createBuffer(
    data: CreateBufferRequest,
    createdBy: string,
  ): Promise<ExchangeRateBuffer> {
    const result = await pool.query(
      `INSERT INTO exchange_rate_buffers
         (provider, currency_pair, buffer_percent, min_buffer_pct, max_buffer_pct, volatility_mode, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`,
      [
        data.provider,
        data.currencyPair,
        data.bufferPercent,
        data.minBufferPct ?? 0.1,
        data.maxBufferPct ?? 5.0,
        data.volatilityMode ?? "static",
        createdBy,
      ],
    );

    const config = mapRow(result.rows[0]);
    await this.logAudit(config.id, "CREATE", null, config, createdBy);
    return config;
  }

  async updateBuffer(
    id: string,
    data: UpdateBufferRequest,
    updatedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<ExchangeRateBuffer | null> {
    const old = await this.getBufferById(id);
    if (!old) return null;

    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.bufferPercent !== undefined) {
      fields.push(`buffer_percent = $${idx++}`);
      values.push(data.bufferPercent);
    }
    if (data.minBufferPct !== undefined) {
      fields.push(`min_buffer_pct = $${idx++}`);
      values.push(data.minBufferPct);
    }
    if (data.maxBufferPct !== undefined) {
      fields.push(`max_buffer_pct = $${idx++}`);
      values.push(data.maxBufferPct);
    }
    if (data.volatilityMode !== undefined) {
      fields.push(`volatility_mode = $${idx++}`);
      values.push(data.volatilityMode);
    }
    if (data.isActive !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(data.isActive);
    }

    if (fields.length === 0) return old;

    fields.push(`updated_by = $${idx++}`);
    values.push(updatedBy);
    values.push(id);

    const result = await pool.query(
      `UPDATE exchange_rate_buffers SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
      values,
    );

    if (result.rows.length === 0) return null;

    const updated = mapRow(result.rows[0]);
    await cacheInvalidate(`${old.provider}:${old.currencyPair}`);
    await this.logAudit(id, "UPDATE", old, updated, updatedBy, ipAddress, userAgent);
    return updated;
  }

  async deleteBuffer(
    id: string,
    deletedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<boolean> {
    const old = await this.getBufferById(id);
    if (!old) return false;

    const result = await pool.query("DELETE FROM exchange_rate_buffers WHERE id = $1", [id]);
    if ((result.rowCount ?? 0) === 0) return false;

    await cacheInvalidate(`${old.provider}:${old.currencyPair}`);
    await this.logAudit(id, "DELETE", old, null, deletedBy, ipAddress, userAgent);
    return true;
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  async getAllBuffers(): Promise<ExchangeRateBuffer[]> {
    const result = await pool.query(
      "SELECT * FROM exchange_rate_buffers ORDER BY provider, currency_pair",
    );
    return result.rows.map(mapRow);
  }

  async getBufferById(id: string): Promise<ExchangeRateBuffer | null> {
    const result = await pool.query("SELECT * FROM exchange_rate_buffers WHERE id = $1", [id]);
    return result.rows.length ? mapRow(result.rows[0]) : null;
  }

  async getBuffersByProvider(provider: string): Promise<ExchangeRateBuffer[]> {
    const result = await pool.query(
      "SELECT * FROM exchange_rate_buffers WHERE provider = $1 ORDER BY currency_pair",
      [provider],
    );
    return result.rows.map(mapRow);
  }

  // ─── Audit ─────────────────────────────────────────────────────────────────

  private async logAudit(
    bufferId: string,
    action: string,
    oldValues: any,
    newValues: any,
    changedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO exchange_rate_buffer_audit
           (buffer_id, action, old_values, new_values, changed_by, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          bufferId,
          action,
          oldValues ? JSON.stringify(oldValues) : null,
          newValues ? JSON.stringify(newValues) : null,
          changedBy,
          ipAddress ?? null,
          userAgent ?? null,
        ],
      );
    } catch (err) {
      logger.warn({ err }, "[ERB] Failed to log audit entry");
    }
  }
}

export const exchangeRateBufferService = new ExchangeRateBufferService();
