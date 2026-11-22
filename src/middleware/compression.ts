import compression from "compression";
import type { Request, Response } from "express";

/**
 * Filter function to determine whether the HTTP response should be compressed.
 * Bypasses compression when:
 * - The request contains the "x-no-compression" header
 * - The response already contains a Content-Encoding header
 * - The response content-type is already compressed (e.g. image, video, audio, zip, gzip, brotli)
 */
export function shouldCompress(req: Request, res: Response): boolean {
  if (req.headers["x-no-compression"]) {
    return false;
  }

  if (res.getHeader("content-encoding")) {
    return false;
  }

  const contentType = res.getHeader("content-type") as string | undefined;
  if (
    contentType &&
    (contentType.includes("image/") ||
      contentType.includes("video/") ||
      contentType.includes("audio/") ||
      contentType.includes("text/event-stream") ||
      contentType.includes("application/zip") ||
      contentType.includes("application/gzip") ||
      contentType.includes("application/x-brotli"))
  ) {
    return false;
  }

  return compression.filter(req, res);
}

export interface CompressionMiddlewareOptions {
  threshold?: number;
  level?: number;
}

/**
 * Creates an Express compression middleware instance supporting both Gzip and Brotli.
 * Bypasses responses under the configured threshold (default 1024 bytes).
 */
export function createCompressionMiddleware(
  options: CompressionMiddlewareOptions = {},
) {
  const threshold =
    options.threshold ??
    parseInt(process.env.COMPRESSION_THRESHOLD || "1024", 10);
  const level =
    options.level ?? parseInt(process.env.COMPRESSION_LEVEL || "6", 10);

  return compression({
    threshold,
    level,
    filter: shouldCompress,
  });
}

/**
 * Preconfigured compression middleware instance with Brotli and Gzip support
 * and 1024-byte (1KB) threshold.
 */
export const compressionMiddleware = createCompressionMiddleware();

export default compressionMiddleware;
