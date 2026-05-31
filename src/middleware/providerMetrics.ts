import { Request, Response, NextFunction } from "express";
import { transactionErrorsTotal, transactionTotal } from "../utils/metrics";

/**
 * Track provider operations and update metrics
 * This middleware hooks into the request/response cycle to capture
 * transaction success/failure and update the Prometheus metrics
 * used by PagerDuty monitoring
 */
export function providerMetricsMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  // Extract provider and operation info from the request
  // This is called for all requests, but we filter for provider-relevant ones
  const providerInfo = extractProviderInfo(req);

  if (providerInfo) {
    // Increment total request count for this provider
    transactionTotal
      .labels(providerInfo.transactionType, providerInfo.provider, "initiated")
      .inc();

    // Store provider info on the request for access in response/error handlers
    (req as any).__providerInfo = providerInfo;
  }

  next();
}

/**
 * Track provider operation results
 * Call this when a provider operation completes
 */
export function recordProviderSuccess(
  provider: string,
  transactionType: string,
): void {
  transactionTotal.labels(transactionType, provider, "completed").inc();
}

/**
 * Track provider operation errors
 * Call this when a provider operation fails
 */
export function recordProviderError(
  provider: string,
  transactionType: string,
  errorType: string,
): void {
  transactionErrorsTotal.labels(transactionType, provider, errorType).inc();

  transactionTotal.labels(transactionType, provider, "failed").inc();
}

/**
 * Extract provider information from request
 * Attempts to determine which provider this request is for
 */
function extractProviderInfo(
  req: Request,
): { provider: string; transactionType: string } | null {
  const path = req.path;

  // Provider payment routes
  if (path.includes("/payment") || path.includes("/send")) {
    return {
      provider: "external", // Could be enhanced to detect actual provider
      transactionType: "payment",
    };
  }

  // Provider payout routes
  if (path.includes("/payout") || path.includes("/withdraw")) {
    return {
      provider: "external",
      transactionType: "payout",
    };
  }

  // Transaction routes (generic)
  if (path.includes("/transaction")) {
    return {
      provider: "external",
      transactionType: "transaction",
    };
  }

  return null;
}
