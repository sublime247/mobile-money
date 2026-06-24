import logger from "../utils/logger";
import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

export const auditInterceptor = (db: Pool) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Only track mutation requests; ignore read-only methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    // Extract admin identification (adjust based on your JWT/session shape)
    const adminId = req.jwtUser?.userId || req.user?.id || 'unknown_admin';
    const action = `${req.method} ${req.originalUrl}`;
    
    // Attempt to parse resource and identifier from the path
    const pathParts = req.originalUrl.split('?')[0].split('/').filter(Boolean);
    const resource = pathParts[1] || 'system';
    const resourceId = req.params.id || req.body.id || req.query.id || null;
    
    // Capture the inbound state
    const payloadBefore = { ...req.body };
    
    // Override res.json to capture the outbound state (the "after" diff)
    const originalJson = res.json;
    res.json = function (body) {
      res.json = originalJson; // Restore original function to prevent memory leaks
      
      // Save log asynchronously to avoid blocking the HTTP response
      setImmediate(async () => {
        try {
          const diff = {
            request_payload: payloadBefore,
            response_payload: body,
          };
          
          const query = `
            INSERT INTO audit_logs (admin_id, action, resource, resource_id, diff, ip_address, user_agent)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `;
          
          await db.query(query, [
            adminId,
            action,
            resource,
            resourceId,
            JSON.stringify(diff),
            req.ip,
            req.get('user-agent') || null
          ]);
        } catch (error) {
          logger.error('[Audit Log] Failed to save admin audit log event:', error);
        }
      });
      
      return res.json(body);
    };

    next();
  };
};