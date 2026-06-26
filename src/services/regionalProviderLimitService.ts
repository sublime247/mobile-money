import { pool } from "../config/database";
import NodeCache from "node-cache";

export interface RegionalProviderLimit {
  id?: string;
  provider_name: string;
  region_code: string;
  country_code: string;
  daily_limit_xaf: number;
  per_transaction_limit_xaf: number;
  currency: string;
  is_active: boolean;
  effective_date: Date;
  expiry_date?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface RegionalLimitCheckResult {
  hasRegionalLimit: boolean;
  dailyLimit: number;
  perTransactionLimit: number;
  regionalLimit?: RegionalProviderLimit;
}

export class RegionalProviderLimitService {
  private cache: NodeCache;

  constructor() {
    // Cache for 5 minutes - regional limits change infrequently
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 600 });
  }

  /**
   * Get regional limit for a specific provider and country
   */
  public async getRegionalLimit(
    providerName: string,
    countryCode: string,
  ): Promise<RegionalProviderLimit | null> {
    const cacheKey = `regional_limit_${providerName.toLowerCase()}_${countryCode.toUpperCase()}`;
    const cached = this.cache.get<RegionalProviderLimit>(cacheKey);
    
    if (cached) {
      return cached;
    }

    const query = `
      SELECT *
      FROM regional_provider_limits
      WHERE provider_name = $1
        AND country_code = $2
        AND is_active = true
        AND (expiry_date IS NULL OR expiry_date > NOW())
        AND effective_date <= NOW()
      ORDER BY effective_date DESC
      LIMIT 1;
    `;

    const result = await pool.query(query, [
      providerName.toLowerCase(),
      countryCode.toUpperCase(),
    ]);

    const limit = result.rows[0] || null;
    
    if (limit) {
      this.cache.set(cacheKey, limit);
    }

    return limit;
  }

  /**
   * Get regional limit by region code (fallback when country code not available)
   */
  public async getRegionalLimitByRegion(
    providerName: string,
    regionCode: string,
  ): Promise<RegionalProviderLimit | null> {
    const cacheKey = `regional_limit_${providerName.toLowerCase()}_region_${regionCode.toLowerCase()}`;
    const cached = this.cache.get<RegionalProviderLimit>(cacheKey);
    
    if (cached) {
      return cached;
    }

    const query = `
      SELECT *
      FROM regional_provider_limits
      WHERE provider_name = $1
        AND region_code = $2
        AND is_active = true
        AND (expiry_date IS NULL OR expiry_date > NOW())
        AND effective_date <= NOW()
      ORDER BY effective_date DESC
      LIMIT 1;
    `;

    const result = await pool.query(query, [
      providerName.toLowerCase(),
      regionCode.toLowerCase(),
    ]);

    const limit = result.rows[0] || null;
    
    if (limit) {
      this.cache.set(cacheKey, limit);
    }

    return limit;
  }

  /**
   * Check if a provider has regional limits and return applicable limits
   */
  public async checkRegionalLimits(
    providerName: string,
    countryCode?: string,
    regionCode?: string,
  ): Promise<RegionalLimitCheckResult> {
    // Try country-specific limit first
    let regionalLimit = countryCode 
      ? await this.getRegionalLimit(providerName, countryCode)
      : null;

    // Fallback to region-specific limit
    if (!regionalLimit && regionCode) {
      regionalLimit = await this.getRegionalLimitByRegion(providerName, regionCode);
    }

    if (regionalLimit) {
      return {
        hasRegionalLimit: true,
        dailyLimit: parseFloat(regionalLimit.daily_limit_xaf),
        perTransactionLimit: parseFloat(regionalLimit.per_transaction_limit_xaf),
        regionalLimit,
      };
    }

    return {
      hasRegionalLimit: false,
      dailyLimit: 0,
      perTransactionLimit: 0,
    };
  }

  /**
   * Create or update a regional provider limit
   */
  public async upsertRegionalLimit(
    providerName: string,
    regionCode: string,
    countryCode: string,
    dailyLimitXaf: number,
    perTransactionLimitXaf: number,
    currency: string = 'XAF',
    effectiveDate?: Date,
    expiryDate?: Date,
  ): Promise<RegionalProviderLimit> {
    const pName = providerName.toLowerCase();
    const rCode = regionCode.toLowerCase();
    const cCode = countryCode.toUpperCase();
    const effDate = effectiveDate || new Date();

    const query = `
      INSERT INTO regional_provider_limits 
        (provider_name, region_code, country_code, daily_limit_xaf, per_transaction_limit_xaf, currency, effective_date, expiry_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (provider_name, region_code, country_code, effective_date)
      DO UPDATE SET
        daily_limit_xaf = EXCLUDED.daily_limit_xaf,
        per_transaction_limit_xaf = EXCLUDED.per_transaction_limit_xaf,
        currency = EXCLUDED.currency,
        expiry_date = EXCLUDED.expiry_date,
        updated_at = NOW()
      RETURNING *;
    `;

    const result = await pool.query(query, [
      pName,
      rCode,
      cCode,
      dailyLimitXaf,
      perTransactionLimitXaf,
      currency,
      effDate,
      expiryDate,
    ]);

    // Clear relevant caches
    this.cache.del(`regional_limit_${pName}_${cCode}`);
    this.cache.del(`regional_limit_${pName}_region_${rCode}`);

    return result.rows[0];
  }

  /**
   * Deactivate a regional limit
   */
  public async deactivateRegionalLimit(
    providerName: string,
    countryCode: string,
    effectiveDate?: Date,
  ): Promise<void> {
    const pName = providerName.toLowerCase();
    const cCode = countryCode.toUpperCase();
    const effDate = effectiveDate || new Date();

    const query = `
      UPDATE regional_provider_limits
      SET is_active = false, updated_at = NOW()
      WHERE provider_name = $1
        AND country_code = $2
        AND effective_date = $3;
    `;

    await pool.query(query, [pName, cCode, effDate]);

    // Clear cache
    this.cache.del(`regional_limit_${pName}_${cCode}`);
  }

  /**
   * Get all active regional limits for a provider
   */
  public async getActiveLimitsForProvider(
    providerName: string,
  ): Promise<RegionalProviderLimit[]> {
    const cacheKey = `regional_limits_provider_${providerName.toLowerCase()}`;
    const cached = this.cache.get<RegionalProviderLimit[]>(cacheKey);
    
    if (cached) {
      return cached;
    }

    const query = `
      SELECT *
      FROM regional_provider_limits
      WHERE provider_name = $1
        AND is_active = true
        AND (expiry_date IS NULL OR expiry_date > NOW())
        AND effective_date <= NOW()
      ORDER BY country_code, region_code;
    `;

    const result = await pool.query(query, [providerName.toLowerCase()]);
    
    this.cache.set(cacheKey, result.rows);
    return result.rows;
  }
}

export const regionalProviderLimitService = new RegionalProviderLimitService();