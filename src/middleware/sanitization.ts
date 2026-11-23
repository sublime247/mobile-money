import { Request, Response, NextFunction } from "express";

// Regular expressions for detecting malicious injection payloads
const SQL_INJECTION_PATTERN =
  /(?:\b(?:UNION\s+(?:ALL\s+)?SELECT|SELECT\s+.*?\s+FROM|INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|EXEC\s*\(|EXECUTE\s*\(|xp_cmdshell)\b|--|\bOR\s+['"]?1['"]?\s*=\s*['"]?1\b|\bAND\s+['"]?1['"]?\s*=\s*['"]?1\b)/i;

const SCRIPT_TAG_PATTERN =
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/i;

const XSS_EVENT_PATTERN =
  /(?:javascript\s*:|<iframe\b|<object\b|<embed\b|onerror\s*=|onload\s*=|onclick\s*=|onmouseover\s*=|eval\s*\(|alert\s*\()/i;

const NOSQL_OPERATOR_PATTERN =
  /^\$(?:gt|gte|lt|lte|ne|in|nin|regex|where|exists|or|and|nor|expr|mod|text|all|elemMatch|size|type)$/i;

/**
 * Checks if a given string, object key, or value contains malicious injection payloads
 */
export function detectMaliciousPayload(
  val: unknown,
  depth = 0,
): { malicious: boolean; reason?: string } {
  if (depth > 20) {
    return { malicious: false };
  }

  if (typeof val === "string") {
    // Check for script tags and XSS execution vectors
    if (SCRIPT_TAG_PATTERN.test(val)) {
      return { malicious: true, reason: "Script tag injection detected" };
    }
    if (XSS_EVENT_PATTERN.test(val)) {
      return { malicious: true, reason: "XSS vector detected" };
    }
    // Check for SQL injection patterns
    if (SQL_INJECTION_PATTERN.test(val)) {
      return { malicious: true, reason: "SQL injection vector detected" };
    }
    // Check for NoSQL operator values (e.g. $where code injections)
    if (val.trim().startsWith("$") && NOSQL_OPERATOR_PATTERN.test(val.trim())) {
      return { malicious: true, reason: "NoSQL operator injection detected" };
    }
  } else if (Array.isArray(val)) {
    for (const item of val) {
      const check = detectMaliciousPayload(item, depth + 1);
      if (check.malicious) return check;
    }
  } else if (val !== null && typeof val === "object") {
    for (const [key, value] of Object.entries(val)) {
      // Check if key is a NoSQL injection operator
      if (key.startsWith("$") || NOSQL_OPERATOR_PATTERN.test(key)) {
        return {
          malicious: true,
          reason: `NoSQL operator injection in parameter key: ${key}`,
        };
      }
      // Check key name for SQL / XSS
      const keyCheck = detectMaliciousPayload(key, depth + 1);
      if (keyCheck.malicious) return keyCheck;

      // Check nested value
      const valCheck = detectMaliciousPayload(value, depth + 1);
      if (valCheck.malicious) return valCheck;
    }
  }

  return { malicious: false };
}

/**
 * Deep sanitizes strings by stripping null bytes and dangerous unescaped tags
 * while preserving valid Unicode characters, phone numbers (+...), and international currency symbols.
 */
export function deepSanitize<T>(input: T, depth = 0): T {
  if (depth > 20 || input === null || input === undefined) {
    return input;
  }

  if (typeof input === "string") {
    // Strip null bytes and control characters while preserving valid Unicode, spaces, currencies
    let cleaned = input.replace(/\0/g, "");
    // Strip dangerous HTML script tags if any were somehow bypassed
    cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, "");
    return cleaned as unknown as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => deepSanitize(item, depth + 1)) as unknown as T;
  }

  if (typeof input === "object") {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input)) {
      // Clean null bytes in keys
      const cleanKey = key.replace(/\0/g, "");
      sanitizedObj[cleanKey] = deepSanitize(val, depth + 1);
    }
    return sanitizedObj as unknown as T;
  }

  return input;
}

/**
 * Express middleware that checks req.body, req.query, and req.params for
 * SQL injection, NoSQL injection ($gt, $ne, etc.), and XSS script tags.
 * Rejects malicious requests with HTTP 400 Bad Request, and deeply sanitizes payloads.
 */
export function sanitizationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    // 1. Inspect req.params
    if (req.params) {
      const check = detectMaliciousPayload(req.params);
      if (check.malicious) {
        res.status(400).json({
          error: "Bad Request",
          message: `Malicious input detected in route parameters: ${check.reason}`,
        });
        return;
      }
      req.params = deepSanitize(req.params);
    }

    // 2. Inspect req.query
    if (req.query) {
      const check = detectMaliciousPayload(req.query);
      if (check.malicious) {
        res.status(400).json({
          error: "Bad Request",
          message: `Malicious input detected in query parameters: ${check.reason}`,
        });
        return;
      }
      req.query = deepSanitize(req.query);
    }

    // 3. Inspect req.body
    if (req.body) {
      const check = detectMaliciousPayload(req.body);
      if (check.malicious) {
        res.status(400).json({
          error: "Bad Request",
          message: `Malicious input detected in request payload: ${check.reason}`,
        });
        return;
      }
      req.body = deepSanitize(req.body);
    }

    next();
  } catch (error) {
    next(error);
  }
}

export default sanitizationMiddleware;
