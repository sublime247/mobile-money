import logger from "../utils/logger";
import { Request, Response, RequestHandler } from "express";

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
 * Header name used for explicit API version routing (issue #2285).
 * Clients send `X-API-Version: v1` to pin a specific version.
 */
export const X_API_VERSION_HEADER = "x-api-version";

const normalizeApiVersion = (version: string): string | undefined => {
  const match = version.trim().match(/^v?(\d+)$/i);
  return match ? `v${match[1]}` : undefined;
};

/**
 * Middleware: Extract API version from URL or request headers.
 *
 * Resolution priority (highest → lowest):
 *   1. URL path           e.g. /api/v1/transactions
 *   2. X-API-Version      e.g. X-API-Version: v1          (issue #2285)
 *   3. Accept-Version     e.g. Accept-Version: v1
 *   4. Accept             e.g. Accept: application/vnd.api+json;version=v1
 *   5. Default            CURRENT_VERSION ("v1")
 *
 * When a deprecated version is requested via X-API-Version the middleware
 * attaches a `Deprecation: true` response header so clients can detect and
 * migrate without a breaking change.
 */
export const apiVersionMiddleware: RequestHandler = (req, res, next) => {
  const versionedReq = req as VersionedRequest;

  try {
    let version = CURRENT_VERSION;

    // 1. URL path (e.g. /api/v1/transactions)
    const pathMatch = versionedReq.path.match(/^\/api\/(v\d+)(?:\/|$)/i);
    if (pathMatch) {
      version = normalizeApiVersion(pathMatch[1]) || CURRENT_VERSION;
    } else {
      // 2. X-API-Version header (issue #2285)
      const xApiVersion = versionedReq.get(X_API_VERSION_HEADER);
      const xVersion = xApiVersion
        ? normalizeApiVersion(xApiVersion)
        : undefined;

      if (xVersion) {
        version = xVersion;
      } else {
        // 3. Accept-Version header
        const acceptVersionHeader = versionedReq.get("accept-version");
        const headerVersion = acceptVersionHeader
          ? normalizeApiVersion(acceptVersionHeader)
          : undefined;

        if (headerVersion) {
          version = headerVersion;
        } else {
          // 4. Accept header content negotiation
          const acceptHeader = versionedReq.get("accept");
          const versionMatch = acceptHeader?.match(
            /(?:^|[;\s])version=(v?\d+)/i,
          );
          const acceptVersion = versionMatch
            ? normalizeApiVersion(versionMatch[1])
            : undefined;

          if (acceptVersion) {
            version = acceptVersion;
          }
        }
      }
    }

    // Store version on request object
    versionedReq.apiVersion = version;
    versionedReq.requestedVersion = version;

    // Add version to response headers
    res.setHeader("API-Version", version);
    res.vary("Accept");
    res.vary("Accept-Version");
    res.vary(X_API_VERSION_HEADER);

    // Attach deprecation warning when the resolved version is deprecated
    // (applies regardless of which source provided the version — issue #2285)
    if (DEPRECATED_VERSIONS.includes(version)) {
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

    // Log version information in development
    if (process.env.NODE_ENV === "development") {
      console.log(`[API Version] Path: ${req.path}, Version: ${version}`);
    }

    next();
  } catch (error) {
    logger.error("Error in apiVersionMiddleware:", error);
    next(error);
  }
};

/**
 * Middleware: Validate requested API version is supported.
 *
 * Returns 400 for unrecognised versions.  Deprecation headers are attached
 * upstream in apiVersionMiddleware so they appear even on unsupported-version
 * rejections that still pass through here.
 */
export const validateVersionMiddleware: RequestHandler = (req, res, next) => {
  const versionedReq = req as VersionedRequest;
  const apiVersion = versionedReq.apiVersion || CURRENT_VERSION;

  if (!SUPPORTED_VERSIONS.includes(apiVersion)) {
    res.status(400).json({
      error: "Unsupported API Version",
      message: `API version ${apiVersion} is not supported. Supported versions: ${SUPPORTED_VERSIONS.join(", ")}`,
      supportedVersions: SUPPORTED_VERSIONS,
    });
    return;
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
