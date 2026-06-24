import { pool } from "../config/database";
import logger from "../utils/logger";

export interface AuditLog {
  id: string;
  userId: string;
  action: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export const auditService = {
  /**
   * Fetch audit logs for a specific user
   * @param userId - The user ID to fetch logs for
   * @param limit - Maximum number of logs to return (default: 100)
   * @param offset - Number of logs to skip (default: 0)
   */
  fetchAuditLogs: async (userId: string, limit: number = 100, offset: number = 0): Promise<AuditLog[]> => {
    try {
      const query = `
        SELECT id, user_id as "userId", action, created_at as timestamp, metadata
        FROM audit_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `;
      const result = await pool.query(query, [userId, limit, offset]);
      return result.rows;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to fetch audit logs');
      return [];
    }
  },

  /**
   * Update an existing audit log entry
   * @param log - The audit log to update
   */
  updateAuditLog: async (log: AuditLog): Promise<void> => {
    try {
      const query = `
        UPDATE audit_logs
        SET action = $1, metadata = $2
        WHERE id = $3 AND user_id = $4
      `;
      await pool.query(query, [
        log.action,
        JSON.stringify(log.metadata || {}),
        log.id,
        log.userId,
      ]);
      logger.info({ logId: log.id, userId: log.userId }, 'Audit log updated');
    } catch (error) {
      logger.error({ error, logId: log.id }, 'Failed to update audit log');
      throw new Error("Failed to update audit log");
    }
  },

  /**
   * Log PII (Personally Identifiable Information) access for compliance
   * @param data - PII access details including admin ID, target ID, and metadata
   */
  logPIIAccess: async (data: {
    adminId: string;
    targetId: string;
    resource: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: any;
  }): Promise<void> => {
    try {
      const query = `
        INSERT INTO pii_access_audit_logs (admin_id, target_id, resource, ip_address, user_agent, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
      await pool.query(query, [
        data.adminId,
        data.targetId,
        data.resource,
        data.ipAddress,
        data.userAgent,
        JSON.stringify(data.metadata || {}),
      ]);
      logger.info(
        { 
          adminId: data.adminId, 
          resource: data.resource, 
          targetId: data.targetId 
        }, 
        'PII access logged'
      );
    } catch (error) {
      logger.error({ error, adminId: data.adminId, resource: data.resource }, 'Failed to log PII access');
    }
  },
};
