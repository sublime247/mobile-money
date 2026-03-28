import { Request, Response, NextFunction } from "express";
import { pool } from "../config/database";
import { newEnforcer, Enforcer } from "casbin";
import path from "path";

export interface RBACRequest extends Request {
  user?: {
    id: string;
    role: string;
    permissions: string[];
  };
}

import fs from "fs";

let enforcer: Enforcer;
let isWatching = false;

/**
 * Initialize Casbin Enforcer
 */
export async function initCasbin(): Promise<Enforcer> {
  if (!enforcer) {
    const modelPath = path.resolve(__dirname, "../config/casbin_model.conf");
    const policyPath = path.resolve(__dirname, "../config/casbin_policy.csv");
    enforcer = await newEnforcer(modelPath, policyPath);
    
    // Implement hot-loading
    if (!isWatching) {
      fs.watch(policyPath, async (eventType) => {
        if (eventType === 'change') {
          console.log('Casbin policy file changed, reloading policies...');
          await enforcer.loadPolicy();
        }
      });
      isWatching = true;
    }
  }
  return enforcer;
}

/**
 * Endpoint to artificially reload policies at runtime without restarting the server
 */
export async function reloadCasbinPolicies() {
  if (enforcer) {
    await enforcer.loadPolicy();
  }
}

/**
 * Get user role information from database
 */
async function getUserRole(
  userId: string,
): Promise<{ role_name: string; role_id: string } | null> {
  const query = `
    SELECT r.name as role_name, r.id as role_id
    FROM users u
    JOIN roles r ON u.role_id = r.id
    WHERE u.id = $1
  `;

  const result = await pool.query(query, [userId]);
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Middleware to explicitly check an object and action
 */
export function authorizeObj(resourceType: string, action: string, requireOwnership: boolean = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.jwtUser) {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Authentication required",
        });
      }

      const userRole = await getUserRole(req.jwtUser.userId);
      if (!userRole) {
        return res.status(403).json({
          error: "Forbidden",
          message: "User role not found",
        });
      }

      req.userRole = userRole.role_name;

      const e = await initCasbin();
      
      const sub = {
        id: req.jwtUser.userId,
        role: userRole.role_name
      };

      // In a middleware, we don't have the specific object ID's owner yet unless passed in URL or body.
      // But for ABAC ownership checks before fetching the object, we just pass checkOwner flag.
      // Later, specific routes can call `authorizeDynamic` if they fetch the object inside the route.
      const obj = {
        type: resourceType,
        checkOwner: requireOwnership,
        ownerUserId: requireOwnership ? req.jwtUser.userId : undefined // this assumes the user requests their OWN resource explicitly, but really it should be deferred if possible.
      };

      const allowed = await e.enforce(sub, obj, action);

      if (!allowed) {
        return res.status(403).json({
          error: "Forbidden",
          message: `Insufficient permissions. Required: ${action} on ${resourceType}`,
        });
      }

      next();
    } catch (error) {
      console.error("RBAC permission check error:", error);
      return res.status(500).json({
        error: "Internal server error",
        message: "Failed to check permissions",
      });
    }
  };
}

/**
 * Backwards compatible method: checks permissions.
 * Many legacy routes just pass 'dispute:create', 'admin:system', 'read:own'.
 * We map these old strings to Casbin checks.
 */
export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.jwtUser) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userRole = await getUserRole(req.jwtUser.userId);
      if (!userRole) return res.status(403).json({ error: "Forbidden" });

      req.userRole = userRole.role_name;
      const e = await initCasbin();

      const sub = { id: req.jwtUser.userId, role: userRole.role_name };

      // Parse legacy permission like "dispute:create"
      let objType = "*";
      let act = permission;
      let checkOwn = false;

      if (permission.includes(":")) {
        const parts = permission.split(":");
        objType = parts[0]; // e.g., dispute
        act = parts[1]; // e.g., create
        if (parts[1] === "own" || parts[1] === "all") {
          // It was something like 'read:own' or 'admin:system'
          objType = parts[0];
          act = parts[1];
        }
      }

      const allowed = await e.enforce(sub, { type: objType }, act);

      // If simple policy doesn't allow, check if they are "admin" implicitly by Casbin model.
      if (!allowed && userRole.role_name !== "admin" && userRole.role_name !== "admin:system") {
        return res.status(403).json({
          error: "Forbidden",
          message: `Insufficient permissions. Required: ${permission}`,
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

export function requireAnyPermission(permissions: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.jwtUser) return res.status(401).json({ error: "Unauthorized" });
      const userRole = await getUserRole(req.jwtUser.userId);
      if (!userRole) return res.status(403).json({ error: "Forbidden" });
      
      req.userRole = userRole.role_name;
      const e = await initCasbin();
      const sub = { id: req.jwtUser.userId, role: userRole.role_name };

      if (userRole.role_name === 'admin' || userRole.role_name === 'admin:system') {
        return next();
      }

      let hasPermission = false;
      for (const p of permissions) {
         let objType = "*";
         let act = p;
         if (p.includes(":")) {
           const parts = p.split(":");
           objType = parts[0];
           act = parts[1];
         }
         if (await e.enforce(sub, { type: objType }, act)) {
           hasPermission = true;
           break;
         }
      }

      if (!hasPermission) {
        return res.status(403).json({ error: "Forbidden", message: "Insufficient permissions." });
      }

      next();
    } catch (error) {
      return res.status(500).json({ error: "Internal error" });
    }
  };
}

export function requireRole(role: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.jwtUser) return res.status(401).json({ error: "Unauthorized" });
      const userRole = await getUserRole(req.jwtUser.userId);
      if (!userRole) return res.status(403).json({ error: "Forbidden" });

      req.userRole = userRole.role_name;

      if (userRole.role_name !== role && userRole.role_name !== "admin") {
         return res.status(403).json({ error: "Forbidden", message: `Required: ${role}` });
      }
      next();
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

export function requireOwnDataAccess(action: "read" | "write" | "delete") {
  return authorizeObj("transaction", action, true);
}

export const requireAdmin = requireRole("admin");
export const requireReadAccess = authorizeObj("transaction", "read", false);
export const requireWriteAccess = authorizeObj("transaction", "write", false);

export async function attachUserContext(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.jwtUser) return next();
    const userRole = await getUserRole(req.jwtUser.userId);
    if (userRole) {
      req.userRole = userRole.role_name;
    }
    next();
  } catch (error) {
    next();
  }
}

/**
 * Dynamic ABAC enforcer helper intended to be called inside route handlers.
 * It verifies if the currently logged in user has the permission to perform
 * an 'action' on the specific 'resourceObj' loaded from DB.
 */
export async function authorizeDynamic(userId: string, role: string, resourceType: string, resourceOwnerUserId: string, action: string, checkOwner: boolean = false): Promise<boolean> {
  const e = await initCasbin();
  const sub = { id: userId, role: role };
  const obj = { type: resourceType, checkOwner: checkOwner, ownerUserId: resourceOwnerUserId };
  return await e.enforce(sub, obj, action);
}
