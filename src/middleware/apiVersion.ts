import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * API Versioning Configuration
 * Supports multiple API versions with backward compatibility
 */

export const setApiVersion =
  (version: string): RequestHandler =>
  (req, _res, next) => {
    (req as VersionedRequest).apiVersion = version;
    next();
  };

export interface VersionedRequest extends Request {
  apiVersion?: string;
  requestedVersion?: string;
}

// Current API version
export const CURRENT_VERSION = "v1";
export const SUPPORTED_VERSIONS: string[] = ["v1"];
export const DEPRECATED_VERSIONS: string[] = [];

/**
 * Middleware: Extract API version from URL or Accept header
 * Priority: URL path > Accept header > default (v1)
 */
export const apiVersionMiddleware: RequestHandler = (req, res, next) => {
  const versionedReq = req as VersionedRequest;

  try {
    let version = CURRENT_VERSION;

    // 1. Check URL path for version (e.g., /api/v1/transactions)
    const pathMatch = versionedReq.path.match(/^\/api\/(v\d+)\//);
    if (pathMatch) {
      version = pathMatch[1];
    }

    // 2. Check Accept header (e.g., Accept: application/vnd.api+json;version=v1)
    const acceptHeader = versionedReq.get("accept");
    if (acceptHeader && acceptHeader.includes("version=")) {
      const versionMatch = acceptHeader.match(/version=(v\d+)/);
      if (versionMatch) {
        version = versionMatch[1];
      }
    }

    // Store version on request object
    versionedReq.apiVersion = version;
    versionedReq.requestedVersion = version;

    // Add version to response headers
    res.setHeader("API-Version", version);
    res.setHeader("Vary", "Accept");

    // Log version information in development
    if (process.env.NODE_ENV === "development") {
      console.log(`[API Version] Path: ${req.path}, Version: ${version}`);
    }

    next();
  } catch (error) {
    console.error("Error in apiVersionMiddleware:", error);
    next(error);
  }
};

/**
 * Middleware: Validate requested API version is supported
 */
export const validateVersionMiddleware: RequestHandler = (req, res, next) => {
  const versionedReq = req as VersionedRequest;
  const apiVersion = versionedReq.apiVersion || CURRENT_VERSION;

  if (!SUPPORTED_VERSIONS.includes(apiVersion)) {
    return res.status(400).json({
      error: "Unsupported API Version",
      message: `API version ${apiVersion} is not supported. Supported versions: ${SUPPORTED_VERSIONS.join(", ")}`,
      supportedVersions: SUPPORTED_VERSIONS,
    });
  }

  // Check if version is deprecated
  if (DEPRECATED_VERSIONS.includes(apiVersion)) {
    res.setHeader("Deprecation", "true");
    res.setHeader(
      "Sunset",
      new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toUTCString(),
    );
    res.setHeader(
      "Link",
      `<https://docs.example.com/api/${CURRENT_VERSION}>; rel="latest-version"`,
    );
  }

  next();
};

/**
 * Helper: Get version from request
 */
export const getApiVersion = (req: Request): string => {
  return (req as VersionedRequest).apiVersion || CURRENT_VERSION;
};

/**
 * Helper: Check if version supports a feature
 */
export const supportsFeature = (version: string, feature: string): boolean => {
  const featureMatrix: Record<string, string[]> = {
    v1: ["basic-transactions", "disputes", "bulk-operations", "stats"],
    v2: [
      "basic-transactions",
      "disputes",
      "bulk-operations",
      "stats",
      "webhooks",
      "advanced-filters",
    ],
  };

  return (featureMatrix[version] || []).includes(feature);
};

/**
 * Helper: Create version-aware response
 */
export const createVersionedResponse = (
  version: string,
  data: any,
  meta?: any,
) => {
  return {
    version,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta,
    },
  };
};
