import type { Application } from "express";
import express from "express";
import { compressionMiddleware } from "../middleware/compression";
import session from "express-session";
import { applySecurityMiddleware } from "./express";
import { getSessionCookieOptions, getSessionTrustProxy } from "./session";
import { createRedisStore, SESSION_TTL_SECONDS } from "./redis";
import {
  globalTimeout,
  haltOnTimedout,
  timeoutErrorHandler,
} from "../middleware/timeout";
import { responseTime } from "../middleware/responseTime";
import { requestId } from "../middleware/requestId";
import {
  apiVersionMiddleware,
  validateVersionMiddleware,
} from "../middleware/apiVersion";
import { readReplicaRoutingMiddleware } from "../middleware/readReplicaRouting";
import { dbConnectionLeakDetector } from "../middleware/dbConnectionLeakDetector";
import { i18nMiddleware } from "../utils/i18n";
import { metricsMiddleware } from "../middleware/metrics";
import { tracingMetricsMiddleware } from "../middleware/tracingMetrics";
import { validateStellarNetwork, logStellarNetwork } from "./stellar";
import logger from "../utils/logger";

export interface ServerConfigOptions {
  enableSecurity?: boolean;
  enableTimeout?: boolean;
  timeoutMs?: number;
  sessionSecret?: string;
}

/**
 * Validates baseline server environment configuration on startup.
 */
export function validateServerEnvironment(): void {
  validateStellarNetwork();
  logStellarNetwork();
  logger.info(
    "[ServerConfig] Server environment configuration validated successfully.",
  );
}

import { sanitizationMiddleware } from "../middleware/sanitization";

/**
 * Configures core Express application settings, trust proxy, and body parsers.
 */
export function configureAppCore(app: Application): void {
  app.set("trust proxy", getSessionTrustProxy());
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));
  app.use(sanitizationMiddleware);
  app.use(compressionMiddleware);
}

/**
 * Configures session middleware using Redis store.
 */
export function configureSessionMiddleware(
  app: Application,
  sessionSecret?: string,
): void {
  const secret =
    sessionSecret || process.env.SESSION_SECRET || "default_development_secret";
  const redisStore = createRedisStore();

  const sessionOptions: session.SessionOptions = {
    store: redisStore,
    secret,
    resave: false,
    saveUninitialized: false,
    name: "momo_bridge_sid",
    cookie: getSessionCookieOptions(),
  };

  app.use(session(sessionOptions));
}

/**
 * Applies request tracing, metrics, timeout, and security middleware chain.
 */
export function configureMiddlewareChain(
  app: Application,
  options: ServerConfigOptions = {},
): void {
  const {
    enableSecurity = true,
    enableTimeout = true,
    timeoutMs = 30000,
  } = options;

  app.use(requestId);
  app.use(responseTime);
  app.use(metricsMiddleware);
  app.use(tracingMetricsMiddleware);
  app.use(i18nMiddleware);

  if (enableTimeout) {
    app.use(globalTimeout);
    app.use(haltOnTimedout);
  }

  if (enableSecurity) {
    applySecurityMiddleware(app);
  }

  app.use(readReplicaRoutingMiddleware);
  app.use(dbConnectionLeakDetector);
  app.use((req, res, next) => apiVersionMiddleware(req, res, next));
  app.use((req, res, next) => validateVersionMiddleware(req, res, next));
}

/**
 * Main extracted configuration setup function for Express server initialization.
 */
export function setupServerConfig(
  app: Application,
  options: ServerConfigOptions = {},
): void {
  validateServerEnvironment();
  configureAppCore(app);
  configureSessionMiddleware(app, options.sessionSecret);
  configureMiddlewareChain(app, options);
  logger.info(
    "[ServerConfig] Complete server configuration applied successfully.",
  );
}
