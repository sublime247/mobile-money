import { pool } from "../config/database";
import NodeCache from "node-cache";

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
  public async getProviderSettings(providerName: string): Promise<ProviderSettings | null> {
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
    fallbackOrder: string | null
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
    const result = await pool.query(query, [pName, failureThreshold, timeoutMs, fallbackOrder]);

    // Clear caches
    this.cache.del("all_provider_settings");
    this.cache.del(`provider_setting_${pName}`);

    return result.rows[0];
  }
}

export const providerSettingsService = new ProviderSettingsService();
