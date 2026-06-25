import { pool } from "../config/database";
import NodeCache from "node-cache";

export interface ProviderMaintenanceOutage {
  id?: string;
  provider_name: string;
  starts_at: Date;
  ends_at: Date;
  reason: string | null;
  fallback_provider: string | null;
  notify_users: boolean;
  created_by: string | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface CreateProviderMaintenanceOutageInput {
  providerName: string;
  startsAt: Date | string;
  endsAt: Date | string;
  reason?: string | null;
  fallbackProvider?: string | null;
  notifyUsers?: boolean;
  createdBy?: string | null;
}

export type ProviderMaintenanceRoutingDecision =
  | { action: "proceed" }
  | {
      action: "fallback";
      provider: string;
      outage: ProviderMaintenanceOutage;
      message: string;
    }
  | {
      action: "abort";
      outage: ProviderMaintenanceOutage;
      message: string;
    };

export interface ProviderSettings {
  id?: string;
  provider_name: string;
  failure_threshold: number;
  timeout_ms: number;
  fallback_order: string | null;
  created_at?: Date;
  updated_at?: Date;
}

class ProviderSettingsService {
  private cache: NodeCache;

  constructor() {
    // Cache for 60 seconds. Settings change infrequently.
    this.cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
  }

  /**
   * Retrieves settings for all providers
   */
  public async getAllSettings(): Promise<ProviderSettings[]> {
    const cacheKey = "all_provider_settings";
    const cached = this.cache.get<ProviderSettings[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const query = "SELECT * FROM provider_settings ORDER BY provider_name ASC";
    const result = await pool.query(query);
    this.cache.set(cacheKey, result.rows);
    return result.rows;
  }

  /**
   * Retrieves settings for a specific provider
   */
  public async getProviderSettings(
    providerName: string,
  ): Promise<ProviderSettings | null> {
    const cacheKey = `provider_setting_${providerName.toLowerCase()}`;
    const cached = this.cache.get<ProviderSettings>(cacheKey);
    if (cached) {
      return cached;
    }

    const query = "SELECT * FROM provider_settings WHERE provider_name = $1";
    const result = await pool.query(query, [providerName.toLowerCase()]);

    if (result.rows.length === 0) {
      return null;
    }

    this.cache.set(cacheKey, result.rows[0]);
    return result.rows[0];
  }

  /**
   * Updates or creates settings for a specific provider
   */
  public async upsertProviderSettings(
    providerName: string,
    failureThreshold: number,
    timeoutMs: number,
    fallbackOrder: string | null,
  ): Promise<ProviderSettings> {
    const pName = providerName.toLowerCase();
    const query = `
      INSERT INTO provider_settings (provider_name, failure_threshold, timeout_ms, fallback_order)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (provider_name) 
      DO UPDATE SET 
        failure_threshold = EXCLUDED.failure_threshold,
        timeout_ms = EXCLUDED.timeout_ms,
        fallback_order = EXCLUDED.fallback_order,
        updated_at = NOW()
      RETURNING *;
    `;
    const result = await pool.query(query, [
      pName,
      failureThreshold,
      timeoutMs,
      fallbackOrder,
    ]);

    // Clear caches
    this.cache.del("all_provider_settings");
    this.cache.del(`provider_setting_${pName}`);

    return result.rows[0];
  }

  /**
   * Creates a scheduled provider maintenance outage.
   */
  public async createMaintenanceOutage(
    input: CreateProviderMaintenanceOutageInput,
  ): Promise<ProviderMaintenanceOutage> {
    const providerName = input.providerName.trim().toLowerCase();
    const fallbackProvider =
      input.fallbackProvider?.trim().toLowerCase() || null;
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);

    if (!providerName) {
      throw new Error("providerName is required");
    }

    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new Error("startsAt and endsAt must be valid timestamps");
    }

    if (startsAt >= endsAt) {
      throw new Error("startsAt must be before endsAt");
    }

    if (fallbackProvider === providerName) {
      throw new Error("fallbackProvider must differ from providerName");
    }

    const query = `
      INSERT INTO provider_maintenance_outages (
        provider_name, starts_at, ends_at, reason, fallback_provider, notify_users, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;

    const result = await pool.query(query, [
      providerName,
      startsAt,
      endsAt,
      input.reason ?? null,
      fallbackProvider,
      input.notifyUsers ?? true,
      input.createdBy ?? null,
    ]);

    this.cache.del(`active_provider_outage_${providerName}`);
    return result.rows[0];
  }

  /**
   * Returns the active outage for a provider, if the current time is inside a scheduled window.
   */
  public async getActiveMaintenanceOutage(
    providerName: string,
    at: Date = new Date(),
  ): Promise<ProviderMaintenanceOutage | null> {
    const pName = providerName.toLowerCase();
    const cacheKey = `active_provider_outage_${pName}`;
    const cached = this.cache.get<ProviderMaintenanceOutage | null>(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    const query = `
      SELECT *
      FROM provider_maintenance_outages
      WHERE provider_name = $1
        AND starts_at <= $2
        AND ends_at > $2
      ORDER BY starts_at DESC
      LIMIT 1;
    `;
    const result = await pool.query(query, [pName, at]);
    const outage = result.rows[0] ?? null;

    this.cache.set(cacheKey, outage, 30);
    return outage;
  }

  /**
   * Determines whether a transaction should proceed, fallback, or abort due to maintenance.
   */
  public async resolveMaintenanceRouting(
    providerName: string,
  ): Promise<ProviderMaintenanceRoutingDecision> {
    const outage = await this.getActiveMaintenanceOutage(providerName);

    if (!outage) {
      return { action: "proceed" };
    }

    const message = `Provider ${outage.provider_name} is under scheduled maintenance until ${new Date(
      outage.ends_at,
    ).toISOString()}`;

    if (outage.fallback_provider) {
      return {
        action: "fallback",
        provider: outage.fallback_provider,
        outage,
        message: `${message}; routing to ${outage.fallback_provider}`,
      };
    }

    return { action: "abort", outage, message };
  }
}

export const providerSettingsService = new ProviderSettingsService();
