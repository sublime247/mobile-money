import type { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface StaticCacheOptions {
  maxAgeSeconds?: number; // Cache-Control max-age in seconds (default: 86400 / 1 day)
  maxFileSizeByte?: number; // Maximum file size to cache in memory buffer (default: 10MB)
  enableETag?: boolean; // Enable ETag validation (default: true)
}

export interface CachedFileEntry {
  buffer: Buffer;
  etag: string;
  contentType: string;
  size: number;
  mtime: Date;
}

// In-memory buffer store for static files
const memoryFileCache = new Map<string, CachedFileEntry>();

/**
 * Returns content-type MIME string based on file extension.
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".pdf":
      return "application/pdf";
    case ".yaml":
    case ".yml":
      return "text/yaml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Computes MD5 ETag hash for a Buffer payload.
 */
export function computeETag(buffer: Buffer): string {
  const hash = crypto.createHash("md5").update(buffer).digest("hex");
  return `"${hash}"`;
}

/**
 * Reads and caches a file in memory Buffer store.
 */
export function getOrCacheFile(
  filePath: string,
  maxFileSize: number = 10 * 1024 * 1024,
): CachedFileEntry | null {
  if (memoryFileCache.has(filePath)) {
    return memoryFileCache.get(filePath)!;
  }

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory() || stat.size > maxFileSize) {
    return null;
  }

  const buffer = fs.readFileSync(filePath);
  const etag = computeETag(buffer);
  const contentType = getMimeType(filePath);

  const entry: CachedFileEntry = {
    buffer,
    etag,
    contentType,
    size: stat.size,
    mtime: stat.mtime,
  };

  memoryFileCache.set(filePath, entry);
  return entry;
}

/**
 * Clears the in-memory static file cache buffer.
 */
export function clearStaticMemoryCache(): void {
  memoryFileCache.clear();
}

/**
 * Express middleware that serves static files using in-memory Buffer cache.
 */
export function createStaticCacheMiddleware(
  rootDirectory: string,
  options: StaticCacheOptions = {},
) {
  const {
    maxAgeSeconds = 86400,
    maxFileSizeByte = 10 * 1024 * 1024,
    enableETag = true,
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next();
    }

    const rawUrl = req.originalUrl || req.url || "";
    if (
      rawUrl.includes("..") ||
      rawUrl.includes("%2e%2e") ||
      rawUrl.includes("%2E%2E")
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const relativePath = decodeURIComponent(req.path);
    const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, "");
    const absolutePath = path.join(rootDirectory, safePath);

    const resolvedRoot = path.resolve(rootDirectory);
    if (!absolutePath.startsWith(resolvedRoot)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const cachedFile = getOrCacheFile(absolutePath, maxFileSizeByte);
    if (!cachedFile) {
      return next();
    }

    // Check If-None-Match for 304 Not Modified
    if (enableETag && req.headers["if-none-match"] === cachedFile.etag) {
      res.status(304).end();
      return;
    }

    res.setHeader("Content-Type", cachedFile.contentType);
    res.setHeader("Content-Length", cachedFile.size);
    res.setHeader("Cache-Control", `public, max-age=${maxAgeSeconds}`);
    if (enableETag) {
      res.setHeader("ETag", cachedFile.etag);
    }

    if (req.method === "HEAD") {
      res.status(200).end();
      return;
    }

    res.status(200).send(cachedFile.buffer);
  };
}
