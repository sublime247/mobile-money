import { AsyncLocalStorage } from "async_hooks";
import { Request, Response, NextFunction } from "express";

/**
 * HTTP method-based database routing middleware.
 *
 * Routes database queries based on HTTP method:
 * - GET/HEAD requests → Replica pool (read-only)
 * - POST/PUT/PATCH/DELETE requests → Primary pool (critical writes)
 *
 * This middleware ensures that read-only GET requests are routed to replica
 * instances to balance load and reduce pressure on the primary database,
 * while all write operations are routed to the primary for data consistency.
 *
 * Usage: Add this middleware early in your Express stack:
 *   app.use(readReplicaRoutingMiddleware);
 *
 * The middleware attaches metadata to the request object that services
 * and data access layers can use to select the appropriate database pool.
 * It also runs the rest of the request inside an AsyncLocalStorage context,
 * which `pool.query` in src/config/database.ts reads to send read-only
 * statements to a replica automatically (#2290). Statements on a checked-out
 * client (`pool.connect()`, i.e. transactions) always stay on the primary.
 */
export interface DatabaseRoutingContext {
  /** Whether this request should use the replica pool */
  useReplicaPool: boolean;
  /** HTTP method of the request */
  method: string;
  /** Route path */
  path: string;
}

const dbRoutingStorage = new AsyncLocalStorage<DatabaseRoutingContext>();

/** Routing context of the HTTP request currently being handled, if any. */
export function getDbRoutingContext(): DatabaseRoutingContext | undefined {
  return dbRoutingStorage.getStore();
}

declare module "express" {
  interface Request {
    dbRouting?: DatabaseRoutingContext;
  }
}

export function readReplicaRoutingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Determine if this request should use replica pool based on HTTP method
  const useReplicaPool = isReadOperation(req.method);

  // Attach routing context to request
  const context: DatabaseRoutingContext = {
    useReplicaPool,
    method: req.method,
    path: req.path,
  };
  req.dbRouting = context;

  // Log routing decision in development
  if (
    process.env.NODE_ENV === "development" &&
    process.env.DEBUG_DB_ROUTING === "true"
  ) {
    console.log(
      `[DB Routing] ${req.method} ${req.path} → ${useReplicaPool ? "REPLICA" : "PRIMARY"}`,
    );
  }

  dbRoutingStorage.run(context, next);
}

/**
 * Determines if an HTTP method is a read-only operation
 * @param method HTTP method
 * @returns true if the method is read-only
 */
export function isReadOperation(method: string): boolean {
  const readMethods = ["GET", "HEAD", "OPTIONS"];
  return readMethods.includes(method.toUpperCase());
}

/**
 * Determines if an HTTP method is a write operation
 * @param method HTTP method
 * @returns true if the method requires write operations
 */
export function isWriteOperation(method: string): boolean {
  const writeMethods = ["POST", "PUT", "PATCH", "DELETE"];
  return writeMethods.includes(method.toUpperCase());
}
