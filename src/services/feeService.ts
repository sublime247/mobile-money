import { pool } from "../config/database";
import { redisClient } from "../config/redis";

export interface FeeConfiguration {
  id: string;
  name: string;
  description?: string;
  feePercentage: number;
  feeMinimum: number;
  feeMaximum: number;
  isActive: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeeResult {
  fee: number;
  total: number;
  configUsed: string;
}

export interface CreateFeeConfigRequest {
  name: string;
  description?: string;
  feePercentage: number;
  feeMinimum: number;
  feeMaximum: number;
}

export interface UpdateFeeConfigRequest {
  description?: string;
  feePercentage?: number;
  feeMinimum?: number;
  feeMaximum?: number;
  isActive?: boolean;
}

const CACHE_KEY_PREFIX = "fee_config:";
const ACTIVE_CONFIG_KEY = "fee_config:active";
const CACHE_TTL = 3600; // 1 hour

export class FeeService {
  /**
   * Calculate fee using active configuration
   */
  async calculateFee(amount: number): Promise<FeeResult> {
    const config = await this.getActiveConfiguration();
    
    let fee = amount * (config.feePercentage / 100);
    
    if (fee < config.feeMinimum) fee = config.feeMinimum;
    if (fee > config.feeMaximum) fee = config.feeMaximum;

    return {
      fee: parseFloat(fee.toFixed(2)),
      total: parseFloat((amount + fee).toFixed(2)),
      configUsed: config.name,
    };
  }

  /**
   * Get active fee configuration (cached)
   */
  async getActiveConfiguration(): Promise<FeeConfiguration> {
    // Try cache first
    const cached = await redisClient.get(ACTIVE_CONFIG_KEY);
    if (cached) {
      return JSON.parse(cached);
    }

    // Fetch from database
    const query = `
      SELECT 
        id,
        name,
        description,
        fee_percentage AS "feePercentage",
        fee_minimum AS "feeMinimum", 
        fee_maximum AS "feeMaximum",
        is_active AS "isActive",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fee_configurations 
      WHERE is_active = true 
      ORDER BY updated_at DESC 
      LIMIT 1
    `;

    const result = await pool.query(query);
    if (result.rows.length === 0) {
      throw new Error("No active fee configuration found");
    }

    const config = result.rows[0];
    
    // Cache the result
    await redisClient.setEx(ACTIVE_CONFIG_KEY, CACHE_TTL, JSON.stringify(config));
    
    return config;
  }

  /**
   * Get all fee configurations
   */
  async getAllConfigurations(): Promise<FeeConfiguration[]> {
    const query = `
      SELECT 
        id,
        name,
        description,
        fee_percentage AS "feePercentage",
        fee_minimum AS "feeMinimum",
        fee_maximum AS "feeMaximum", 
        is_active AS "isActive",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fee_configurations 
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query);
    return result.rows;
  }

  /**
   * Get fee configuration by ID
   */
  async getConfigurationById(id: string): Promise<FeeConfiguration | null> {
    // Try cache first
    const cacheKey = `${CACHE_KEY_PREFIX}${id}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const query = `
      SELECT 
        id,
        name,
        description,
        fee_percentage AS "feePercentage",
        fee_minimum AS "feeMinimum",
        fee_maximum AS "feeMaximum",
        is_active AS "isActive", 
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fee_configurations 
      WHERE id = $1
    `;

    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) {
      return null;
    }

    const config = result.rows[0];
    
    // Cache the result
    await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(config));
    
    return config;
  }

  /**
   * Create new fee configuration
   */
  async createConfiguration(
    data: CreateFeeConfigRequest, 
    createdBy: string
  ): Promise<FeeConfiguration> {
    const query = `
      INSERT INTO fee_configurations (
        name, description, fee_percentage, fee_minimum, fee_maximum, created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING 
        id,
        name,
        description,
        fee_percentage AS "feePercentage",
        fee_minimum AS "feeMinimum",
        fee_maximum AS "feeMaximum",
        is_active AS "isActive",
        created_by AS "createdBy", 
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await pool.query(query, [
      data.name,
      data.description,
      data.feePercentage,
      data.feeMinimum,
      data.feeMaximum,
      createdBy,
    ]);

    const config = result.rows[0];
    
    // Log audit entry
    await this.logAuditEntry(config.id, 'CREATE', null, config, createdBy);
    
    return config;
  }
  /**
   * Update fee configuration
   */
  async updateConfiguration(
    id: string,
    data: UpdateFeeConfigRequest,
    updatedBy: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<FeeConfiguration | null> {
    // Get current config for audit
    const oldConfig = await this.getConfigurationById(id);
    if (!oldConfig) {
      return null;
    }

    const updateFields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.description !== undefined) {
      updateFields.push(`description = $${paramIndex++}`);
      values.push(data.description);
    }
    if (data.feePercentage !== undefined) {
      updateFields.push(`fee_percentage = $${paramIndex++}`);
      values.push(data.feePercentage);
    }
    if (data.feeMinimum !== undefined) {
      updateFields.push(`fee_minimum = $${paramIndex++}`);
      values.push(data.feeMinimum);
    }
    if (data.feeMaximum !== undefined) {
      updateFields.push(`fee_maximum = $${paramIndex++}`);
      values.push(data.feeMaximum);
    }
    if (data.isActive !== undefined) {
      updateFields.push(`is_active = $${paramIndex++}`);
      values.push(data.isActive);
    }

    if (updateFields.length === 0) {
      return oldConfig;
    }

    updateFields.push(`updated_by = $${paramIndex++}`);
    values.push(updatedBy);
    values.push(id);

    const query = `
      UPDATE fee_configurations 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING 
        id,
        name,
        description,
        fee_percentage AS "feePercentage",
        fee_minimum AS "feeMinimum",
        fee_maximum AS "feeMaximum",
        is_active AS "isActive",
        created_by AS "createdBy",
        updated_by AS "updatedBy", 
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await pool.query(query, values);
    const newConfig = result.rows[0];

    // Invalidate caches
    await this.invalidateCache(id);
    
    // Log audit entry
    await this.logAuditEntry(id, 'UPDATE', oldConfig, newConfig, updatedBy, ipAddress, userAgent);

    return newConfig;
  }
  /**
   * Delete fee configuration
   */
  async deleteConfiguration(
    id: string, 
    deletedBy: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<boolean> {
    // Get current config for audit
    const oldConfig = await this.getConfigurationById(id);
    if (!oldConfig) {
      return false;
    }

    // Don't allow deleting active configuration
    if (oldConfig.isActive) {
      throw new Error("Cannot delete active fee configuration");
    }

    const query = `DELETE FROM fee_configurations WHERE id = $1`;
    const result = await pool.query(query, [id]);

    if (result.rowCount === 0) {
      return false;
    }

    // Invalidate cache
    await this.invalidateCache(id);
    
    // Log audit entry
    await this.logAuditEntry(id, 'DELETE', oldConfig, null, deletedBy, ipAddress, userAgent);

    return true;
  }

  /**
   * Activate fee configuration (deactivates others)
   */
  async activateConfiguration(
    id: string,
    activatedBy: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<FeeConfiguration | null> {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Deactivate all configurations
      await client.query('UPDATE fee_configurations SET is_active = false');

      // Activate the specified one
      const query = `
        UPDATE fee_configurations 
        SET is_active = true, updated_by = $2
        WHERE id = $1
        RETURNING 
          id,
          name,
          description,
          fee_percentage AS "feePercentage",
          fee_minimum AS "feeMinimum",
          fee_maximum AS "feeMaximum",
          is_active AS "isActive",
          created_by AS "createdBy",
          updated_by AS "updatedBy",
          created_at AS "createdAt", 
          updated_at AS "updatedAt"
      `;

      const result = await client.query(query, [id, activatedBy]);
      
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      await client.query('COMMIT');
      
      const config = result.rows[0];
      
      // Invalidate all caches
      await this.invalidateAllCaches();
      
      // Log audit entry
      await this.logAuditEntry(id, 'ACTIVATE', null, config, activatedBy, ipAddress, userAgent);

      return config;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  /**
   * Get audit history for a fee configuration
   */
  async getAuditHistory(configId: string): Promise<any[]> {
    const query = `
      SELECT 
        a.id,
        a.action,
        a.old_values AS "oldValues",
        a.new_values AS "newValues", 
        a.changed_at AS "changedAt",
        a.ip_address AS "ipAddress",
        a.user_agent AS "userAgent",
        u.phone_number AS "changedByUser"
      FROM fee_configuration_audit a
      JOIN users u ON a.changed_by = u.id
      WHERE a.fee_config_id = $1
      ORDER BY a.changed_at DESC
    `;

    const result = await pool.query(query, [configId]);
    return result.rows;
  }

  /**
   * Log audit entry
   */
  private async logAuditEntry(
    configId: string,
    action: string,
    oldValues: any,
    newValues: any,
    changedBy: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    const query = `
      INSERT INTO fee_configuration_audit (
        fee_config_id, action, old_values, new_values, changed_by, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    await pool.query(query, [
      configId,
      action,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      changedBy,
      ipAddress,
      userAgent,
    ]);
  }

  /**
   * Invalidate cache for specific configuration
   */
  private async invalidateCache(id: string): Promise<void> {
    const cacheKey = `${CACHE_KEY_PREFIX}${id}`;
    await Promise.all([
      redisClient.del(cacheKey),
      redisClient.del(ACTIVE_CONFIG_KEY),
    ]);
  }

  /**
   * Invalidate all fee configuration caches
   */
  private async invalidateAllCaches(): Promise<void> {
    const pattern = `${CACHE_KEY_PREFIX}*`;
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
    await redisClient.del(ACTIVE_CONFIG_KEY);
  }
}

export const feeService = new FeeService();