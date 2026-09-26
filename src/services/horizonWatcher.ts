import logger from "../utils/logger";
import { getStellarServer } from "../config/stellar";
import { redisClient } from "../config/redis";
import {
  getEventSyncCursor,
  setEventSyncCursor,
} from "../database/eventSyncStateRepository";

export interface CursorStore {
  get(streamKey: string): Promise<string | null>;
  set(streamKey: string, cursor: string): Promise<void>;
}

export class MemoryCursorStore implements CursorStore {
  private cursors = new Map<string, string>();

  async get(streamKey: string): Promise<string | null> {
    return this.cursors.get(streamKey) ?? null;
  }

  async set(streamKey: string, cursor: string): Promise<void> {
    this.cursors.set(streamKey, cursor);
  }
}

export class RedisCursorStore implements CursorStore {
  private prefix: string;

  constructor(prefix = "horizon:watcher:cursor:") {
    this.prefix = prefix;
  }

  async get(streamKey: string): Promise<string | null> {
    try {
      if (!redisClient || typeof redisClient.get !== "function") return null;
      const val = await redisClient.get(`${this.prefix}${streamKey}`);
      return val ? String(val) : null;
    } catch (err) {
      logger.warn({ err, streamKey }, "[HorizonWatcher] Redis get cursor failed");
      return null;
    }
  }

  async set(streamKey: string, cursor: string): Promise<void> {
    try {
      if (!redisClient || typeof redisClient.set !== "function") return;
      await redisClient.set(`${this.prefix}${streamKey}`, cursor);
    } catch (err) {
      logger.warn({ err, streamKey, cursor }, "[HorizonWatcher] Redis set cursor failed");
    }
  }
}

export class DbCursorStore implements CursorStore {
  async get(streamKey: string): Promise<string | null> {
    try {
      return await getEventSyncCursor(streamKey);
    } catch (err) {
      logger.warn({ err, streamKey }, "[HorizonWatcher] DB get cursor failed");
      return null;
    }
  }

  async set(streamKey: string, cursor: string): Promise<void> {
    try {
      await setEventSyncCursor(streamKey, cursor);
    } catch (err) {
      logger.warn({ err, streamKey, cursor }, "[HorizonWatcher] DB set cursor failed");
    }
  }
}

export class MultiLayerCursorStore implements CursorStore {
  private primary: CursorStore;
  private secondary: CursorStore;

  constructor(primary?: CursorStore, secondary?: CursorStore) {
    this.primary = primary ?? new RedisCursorStore();
    this.secondary = secondary ?? new DbCursorStore();
  }

  async get(streamKey: string): Promise<string | null> {
    const fromPrimary = await this.primary.get(streamKey);
    if (fromPrimary) return fromPrimary;
    const fromSecondary = await this.secondary.get(streamKey);
    if (fromSecondary) {
      // Warm primary cache
      await this.primary.set(streamKey, fromSecondary);
      return fromSecondary;
    }
    return null;
  }

  async set(streamKey: string, cursor: string): Promise<void> {
    await Promise.allSettled([
      this.primary.set(streamKey, cursor),
      this.secondary.set(streamKey, cursor),
    ]);
  }
}

export type HorizonWatcherStatus =
  | "stopped"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "error";

export interface HorizonWatcherConfig {
  streamKey: string;
  horizon?: any;
  cursorStore?: CursorStore;
  initialCursor?: string;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffFactor?: number;
  jitterRatio?: number;
  maxRetries?: number;
  enableCatchup?: boolean;
  onTransaction?: (tx: any) => Promise<void> | void;
  onError?: (err: any) => void;
  onStatusChange?: (status: HorizonWatcherStatus) => void;
}

export interface HorizonWatcherStats {
  status: HorizonWatcherStatus;
  streamKey: string;
  currentCursor: string;
  transactionsProcessed: number;
  reconnectAttempts: number;
  consecutiveFailures: number;
  lastError: string | null;
  startedAt: Date | null;
}

export class HorizonWatcher {
  private readonly streamKey: string;
  private readonly horizon: any;
  private readonly cursorStore: CursorStore;
  private readonly initialCursor: string;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffFactor: number;
  private readonly jitterRatio: number;
  private readonly maxRetries: number;
  private readonly enableCatchup: boolean;

  private onTransactionCallback?: (tx: any) => Promise<void> | void;
  private onErrorCallback?: (err: any) => void;
  private onStatusChangeCallback?: (status: HorizonWatcherStatus) => void;

  private currentCursor: string;
  private status: HorizonWatcherStatus = "stopped";
  private closeStreamFn: (() => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  private transactionsProcessed = 0;
  private reconnectAttempts = 0;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private startedAt: Date | null = null;

  constructor(config: HorizonWatcherConfig) {
    this.streamKey = config.streamKey;
    this.horizon = config.horizon ?? getStellarServer();
    this.cursorStore = config.cursorStore ?? new MultiLayerCursorStore();
    this.initialCursor = config.initialCursor ?? "now";
    this.currentCursor = this.initialCursor;
    this.initialBackoffMs = config.initialBackoffMs ?? 1000;
    this.maxBackoffMs = config.maxBackoffMs ?? 30000;
    this.backoffFactor = config.backoffFactor ?? 2;
    this.jitterRatio = config.jitterRatio ?? 0.2;
    this.maxRetries = config.maxRetries ?? 0; // 0 = infinite retry
    this.enableCatchup = config.enableCatchup ?? true;

    this.onTransactionCallback = config.onTransaction;
    this.onErrorCallback = config.onError;
    this.onStatusChangeCallback = config.onStatusChange;
  }

  public getStatus(): HorizonWatcherStatus {
    return this.status;
  }

  public getCurrentCursor(): string {
    return this.currentCursor;
  }

  public getStats(): HorizonWatcherStats {
    return {
      status: this.status,
      streamKey: this.streamKey,
      currentCursor: this.currentCursor,
      transactionsProcessed: this.transactionsProcessed,
      reconnectAttempts: this.reconnectAttempts,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }

  private setStatus(newStatus: HorizonWatcherStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.onStatusChangeCallback?.(newStatus);
    }
  }

  public calculateBackoff(attempt: number): number {
    const exponential = Math.min(
      this.initialBackoffMs * Math.pow(this.backoffFactor, attempt),
      this.maxBackoffMs,
    );
    const maxJitter = exponential * this.jitterRatio;
    const jitter = Math.random() * maxJitter;
    return Math.floor(exponential + jitter);
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = new Date();

    // Checkpoint hydration: load latest cursor from store
    const storedCursor = await this.cursorStore.get(this.streamKey);
    if (storedCursor) {
      this.currentCursor = storedCursor;
      logger.info(
        { streamKey: this.streamKey, cursor: this.currentCursor },
        "[HorizonWatcher] Resumed with persisted cursor",
      );
    }

    await this.connect();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.closeStreamFn) {
      try {
        this.closeStreamFn();
      } catch (err) {
        logger.warn({ err }, "[HorizonWatcher] Error while closing stream");
      }
      this.closeStreamFn = null;
    }
    this.setStatus("stopped");
    logger.info({ streamKey: this.streamKey }, "[HorizonWatcher] Stopped stream listener");
  }

  /**
   * Catch-up pass: pages missed transactions during downtime before attaching live stream.
   */
  public async catchupMissedTransactions(): Promise<number> {
    if (!this.enableCatchup) {
      return 0;
    }

    if (this.currentCursor === "now") {
      const stored = await this.cursorStore.get(this.streamKey);
      if (stored) {
        this.currentCursor = stored;
      } else {
        return 0;
      }
    }

    let pagedCount = 0;
    try {
      while (true) {
        const page = await this.horizon
          .transactions()
          .cursor(this.currentCursor)
          .order("asc")
          .limit(100)
          .call();

        const records = page.records ?? [];
        if (records.length === 0) break;

        for (const tx of records) {
          await this.handleTransaction(tx);
          pagedCount++;
        }

        const lastTx = records[records.length - 1];
        if (lastTx?.paging_token) {
          this.currentCursor = lastTx.paging_token;
          await this.cursorStore.set(this.streamKey, this.currentCursor);
        }

        if (records.length < 100) break;
      }
    } catch (err) {
      logger.warn(
        { err, streamKey: this.streamKey, cursor: this.currentCursor },
        "[HorizonWatcher] Error during downtime catch-up pass; continuing to stream",
      );
    }

    return pagedCount;
  }

  private async connect(): Promise<void> {
    if (!this.isRunning) return;

    this.setStatus("connecting");

    // Close any previous stream before opening a new one
    if (this.closeStreamFn) {
      try {
        this.closeStreamFn();
      } catch (_) {}
      this.closeStreamFn = null;
    }

    // Run catch-up pass to prevent missing transactions during temporary downtime
    if (this.consecutiveFailures > 0 && this.currentCursor !== "now") {
      await this.catchupMissedTransactions();
    }

    try {
      const builder = this.horizon.transactions().cursor(this.currentCursor);

      this.closeStreamFn = builder.stream({
        onmessage: async (tx: any) => {
          this.consecutiveFailures = 0;
          this.setStatus("streaming");
          await this.handleTransaction(tx);
        },
        onerror: (err: any) => {
          this.handleStreamError(err);
        },
      });

      this.setStatus("streaming");
      logger.info(
        { streamKey: this.streamKey, cursor: this.currentCursor },
        "[HorizonWatcher] SSE Stream opened successfully",
      );
    } catch (err) {
      this.handleStreamError(err);
    }
  }

  private async handleTransaction(tx: any): Promise<void> {
    try {
      this.transactionsProcessed++;
      if (tx?.paging_token) {
        this.currentCursor = tx.paging_token;
        await this.cursorStore.set(this.streamKey, this.currentCursor);
      }
      if (this.onTransactionCallback) {
        await this.onTransactionCallback(tx);
      }
    } catch (err) {
      logger.error(
        { err, streamKey: this.streamKey, txHash: tx?.hash },
        "[HorizonWatcher] Error processing transaction callback",
      );
    }
  }

  private handleStreamError(err: any): void {
    if (!this.isRunning) return;

    this.consecutiveFailures++;
    this.reconnectAttempts++;
    this.lastError = err?.message ?? String(err);

    this.onErrorCallback?.(err);

    if (this.maxRetries > 0 && this.consecutiveFailures > this.maxRetries) {
      logger.error(
        {
          streamKey: this.streamKey,
          failures: this.consecutiveFailures,
          maxRetries: this.maxRetries,
        },
        "[HorizonWatcher] Maximum retry limit exceeded, transitioning to error state",
      );
      this.setStatus("error");
      return;
    }

    this.setStatus("reconnecting");
    const delay = this.calculateBackoff(this.consecutiveFailures - 1);

    logger.warn(
      {
        streamKey: this.streamKey,
        error: this.lastError,
        attempt: this.consecutiveFailures,
        reconnectInMs: delay,
      },
      "[HorizonWatcher] Stream disconnected or errored; scheduling reconnection",
    );

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((connErr) => {
        logger.error(
          { connErr, streamKey: this.streamKey },
          "[HorizonWatcher] Reconnection attempt failed",
        );
      });
    }, delay);
  }
}
