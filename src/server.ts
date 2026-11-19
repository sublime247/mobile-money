import express, { Application, Request, Response, NextFunction } from "express";
import { Server as HttpServer } from "http";
import { Socket } from "net";
import {
  setupServerConfig,
  validateServerEnvironment,
  ServerConfigOptions,
} from "./config/serverConfig";
import { createError, errorHandler } from "./middleware/errorHandler";
import { timeoutErrorHandler } from "./middleware/timeout";
import { sanitizationMiddleware } from "./middleware/sanitization";
import { ERROR_CODES } from "./constants/errorCodes";
import logger from "./utils/logger";

/**
 * Creates and configures a fully setup Express Application instance.
 */
export function createConfiguredServer(
  options?: ServerConfigOptions,
): Application {
  const app = express();
  app.use(sanitizationMiddleware);
  setupServerConfig(app, options);
  return app;
}

/**
 * Attaches global error handlers to Express Application.
 */
export function registerErrorHandlers(app: Application): void {
  app.use(timeoutErrorHandler);
  app.use(errorHandler);
}

export { setupServerConfig, validateServerEnvironment };

export type ClosableServer =
  | HttpServer
  | {
      close: (cb?: (err?: Error) => void) => void;
      on?: (event: string, listener: (...args: any[]) => void) => void;
      closeIdleConnections?: () => void;
    };

export interface GracefulShutdownOptions {
  server?: ClosableServer | null;
  pool?: { end: () => Promise<unknown> } | null;
  redisClient?: { disconnect?: () => Promise<unknown>; quit?: () => Promise<unknown> } | null;
  disconnectRedis?: () => Promise<unknown>;
  timeoutMs?: number;
  /**
   * Max time to wait for `onCleanup` (queue workers closing, letting
   * in-flight BullMQ jobs finish, etc.) before giving up and continuing the
   * shutdown anyway. Default 30s, matching BullMQ's recommended grace
   * period for in-flight job completion. Without this bound, a single
   * hung job would block the DB pool and Redis from ever closing and the
   * process would never exit on SIGTERM/SIGINT.
   */
  onCleanupTimeoutMs?: number;
  signals?: NodeJS.Signals[];
  onShutdownStart?: (signal: string) => void | Promise<void>;
  onCleanup?: () => void | Promise<void>;
  exitProcess?: boolean;
}

/**
 * Graceful shutdown handler managing active HTTP requests, sockets,
 * database connection pools, and Redis clients.
 */
export class GracefulShutdownHandler {
  private server: ClosableServer | null = null;
  private pool: { end: () => Promise<unknown> } | null = null;
  private redisClient: { disconnect?: () => Promise<unknown>; quit?: () => Promise<unknown> } | null = null;
  private disconnectRedisFn: (() => Promise<unknown>) | null = null;
  private timeoutMs: number;
  private signals: NodeJS.Signals[];
  private onShutdownStart?: (signal: string) => void | Promise<void>;
  private onCleanup?: () => void | Promise<void>;
  private onCleanupTimeoutMs: number;
  private exitProcess: boolean;

  private isShuttingDown = false;
  private shutdownInProgress = false;
  private activeRequests = 0;
  private trackedSockets = new Set<Socket>();
  private signalListeners: Array<{ signal: NodeJS.Signals; listener: () => void }> = [];

  constructor(options: GracefulShutdownOptions = {}) {
    if (options.server) {
      this.setServer(options.server);
    }
    this.pool = options.pool ?? null;
    this.redisClient = options.redisClient ?? null;
    this.disconnectRedisFn = options.disconnectRedis ?? null;
    // Default wait up to 10 seconds (10000ms) for in-flight requests per acceptance criteria
    this.timeoutMs = options.timeoutMs ?? parseInt(process.env.SHUTDOWN_TIMEOUT_MS || "10000", 10);
    this.signals = options.signals ?? ["SIGTERM", "SIGINT"];
    this.onShutdownStart = options.onShutdownStart;
    this.onCleanup = options.onCleanup;
    this.onCleanupTimeoutMs =
      options.onCleanupTimeoutMs ??
      parseInt(process.env.QUEUE_SHUTDOWN_TIMEOUT_MS || "30000", 10);
    this.exitProcess = options.exitProcess ?? (process.env.NODE_ENV !== "test");
  }

  public setServer(server: ClosableServer | null): void {
    this.server = server;
    if (server && typeof server.on === "function") {
      server.on("connection", (...args: unknown[]) => {
        const socket = args[0] as Socket;
        if (socket && typeof socket.once === "function") {
          this.trackedSockets.add(socket);
          socket.once("close", () => {
            this.trackedSockets.delete(socket);
          });
        }
      });
      server.on("secureConnection", (...args: unknown[]) => {
        const socket = args[0] as Socket;
        if (socket && typeof socket.once === "function") {
          this.trackedSockets.add(socket);
          socket.once("close", () => {
            this.trackedSockets.delete(socket);
          });
        }
      });
    }
  }

  public setPool(pool: { end: () => Promise<unknown> } | null): void {
    this.pool = pool;
  }

  public setRedisDisconnect(disconnectRedis: () => Promise<unknown>): void {
    this.disconnectRedisFn = disconnectRedis;
  }

  public getIsShuttingDown(): boolean {
    return this.isShuttingDown;
  }

  public getActiveRequests(): number {
    return this.activeRequests;
  }

  /**
   * Express middleware that stops new incoming requests when shutting down
   * and tracks active in-flight requests.
   */
  public middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (this.isShuttingDown) {
      res.setHeader("Connection", "close");
      throw createError(ERROR_CODES.SERVICE_UNAVAILABLE, "Service Unavailable", {
        error: "Service Unavailable",
        message: "Server is shutting down. Please retry shortly.",
      });
    }

    this.activeRequests += 1;
    let completed = false;

    const onRequestFinished = () => {
      if (completed) {
        return;
      }
      completed = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    };

    res.on("finish", onRequestFinished);
    res.on("close", onRequestFinished);

    next();
  };

  /**
   * Waits for all in-flight requests to complete or until timeout expires.
   */
  public async waitForActiveRequests(timeoutMs?: number): Promise<void> {
    const limit = timeoutMs ?? this.timeoutMs;
    if (this.activeRequests === 0) {
      return;
    }

    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (this.activeRequests === 0 || Date.now() - startedAt >= limit) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });
  }

  /**
   * Runs `fn` but gives up after `timeoutMs`, logging a warning instead of
   * letting a hung cleanup step (e.g. a BullMQ job that never settles)
   * block the rest of the shutdown sequence indefinitely.
   */
  private async runCleanupWithTimeout(
    fn: () => void | Promise<void>,
    timeoutMs: number,
  ): Promise<void> {
    let timedOut = false;

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs).unref?.();
    });

    await Promise.race([Promise.resolve(fn()), timeoutPromise]);

    if (timedOut) {
      logger.warn(
        `[Shutdown] Cleanup did not complete within ${timeoutMs}ms; continuing shutdown anyway (in-flight jobs may be interrupted)`,
      );
    }
  }

  /**
   * Executes the graceful shutdown sequence.
   */
  public async shutdown(signal: NodeJS.Signals | string = "SIGTERM"): Promise<void> {
    if (this.shutdownInProgress) {
      logger.info(`[Shutdown] ${signal} received; shutdown already in progress`);
      return;
    }

    this.shutdownInProgress = true;
    this.isShuttingDown = true;
    logger.info(`[Shutdown] Received ${signal}. Starting graceful shutdown...`);

    try {
      if (this.onShutdownStart) {
        await this.onShutdownStart(signal);
      }

      // 1. Stop accepting new HTTP connections
      let serverClosePromise: Promise<void> | null = null;
      if (this.server) {
        logger.info("[Shutdown] Stopping HTTP server from accepting new requests");
        serverClosePromise = new Promise<void>((resolve, reject) => {
          this.server?.close((error?: Error & { code?: string }) => {
            if (error) {
              if (error.code === "ERR_SERVER_NOT_RUNNING") {
                resolve();
                return;
              }
              reject(error);
              return;
            }
            resolve();
          });
        });

        // Close idle connections if supported in runtime
        if (typeof this.server.closeIdleConnections === "function") {
          this.server.closeIdleConnections();
        }
      }

      // 2. Wait up to timeout (default 10s) for in-flight requests to complete
      const pendingAtStart = this.activeRequests;
      if (pendingAtStart > 0) {
        logger.info(
          `[Shutdown] Waiting for ${pendingAtStart} active request(s) to finish (timeout ${this.timeoutMs}ms)`,
        );
      }

      await this.waitForActiveRequests(this.timeoutMs);

      if (this.activeRequests > 0) {
        logger.warn(
          `[Shutdown] Timed out waiting for active requests. Remaining: ${this.activeRequests}. Force closing active connections.`,
        );
        for (const socket of this.trackedSockets) {
          socket.destroy();
        }
        this.trackedSockets.clear();
      } else {
        logger.info("[Shutdown] All active requests finished");
      }

      if (serverClosePromise) {
        await serverClosePromise;
        logger.info("[Shutdown] HTTP listener closed");
      }

      // 3. Custom cleanup (queue drainage, heartbeat, etc.) — bounded so a
      //    single hung in-flight job can't block the rest of shutdown
      //    (DB pool / Redis close, process exit) forever.
      if (this.onCleanup) {
        await this.runCleanupWithTimeout(this.onCleanup, this.onCleanupTimeoutMs);
      }

      // 4. Close PostgreSQL pool
      if (this.pool) {
        logger.info("[Shutdown] Closing PostgreSQL pool");
        await this.pool.end();
        logger.info("[Shutdown] PostgreSQL pool closed");
      }

      // 5. Close Redis clients
      if (this.disconnectRedisFn) {
        logger.info("[Shutdown] Closing Redis connection via disconnectRedis");
        await this.disconnectRedisFn();
        logger.info("[Shutdown] Redis connection closed");
      } else if (this.redisClient) {
        logger.info("[Shutdown] Closing Redis client");
        if (typeof this.redisClient.quit === "function") {
          await this.redisClient.quit();
        } else if (typeof this.redisClient.disconnect === "function") {
          await this.redisClient.disconnect();
        }
        logger.info("[Shutdown] Redis client closed");
      }

      logger.info("[Shutdown] Graceful shutdown complete");

      if (this.exitProcess) {
        process.exit(0);
      }
    } catch (error) {
      logger.error("[Shutdown] Shutdown sequence failed", error);
      if (this.exitProcess) {
        process.exit(1);
      }
      throw error;
    }
  }

  /**
   * Registers SIGTERM and SIGINT signal handlers.
   */
  public registerSignalHandlers(): () => void {
    for (const sig of this.signals) {
      const listener = () => {
        void this.shutdown(sig);
      };
      process.once(sig, listener);
      this.signalListeners.push({ signal: sig, listener });
    }

    return () => {
      for (const { signal, listener } of this.signalListeners) {
        process.removeListener(signal, listener);
      }
      this.signalListeners = [];
    };
  }
}

export function createGracefulShutdownHandler(
  options?: GracefulShutdownOptions,
): GracefulShutdownHandler {
  return new GracefulShutdownHandler(options);
}
