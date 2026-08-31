import { getStellarServer } from "../../config/stellar";
import {
  getEventSyncCursor,
  setEventSyncCursor,
  INITIAL_SYNC_CURSOR,
} from "../../database/eventSyncStateRepository";
import logger from "../../utils/logger";

export type LedgerTransactionHandler = (
  tx: any,
) => Promise<void> | void;

export interface LedgerScannerConfig {
  /** Stream key or account identifier for cursor persistence. */
  streamKey: string;
  /** Stellar account/contract address to scan transactions for. */
  contractId?: string;
  /** Number of transactions per page (max 200). */
  chunkSize?: number;
  /** Poll interval in milliseconds when at the ledger tip. */
  pollIntervalMs?: number;
  /** Injected Horizon server for testing. */
  horizon?: any;
}

export interface LedgerScannerResult {
  pages: number;
  transactions: number;
}

/**
 * LedgerScanner
 * Optimizes the ledger listener loop to ensure no transactions are missed
 * during brief database reconnects by storing the last scanned cursor in the database
 * and fetching ledger records sequentially using transaction paging tokens.
 */
export class LedgerScanner {
  private readonly streamKey: string;
  private readonly contractId?: string;
  private readonly chunkSize: number;
  private readonly pollIntervalMs: number;
  private readonly horizon: any;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(config: LedgerScannerConfig) {
    this.streamKey = config.streamKey;
    this.contractId = config.contractId;
    this.chunkSize = Math.min(Math.max(1, config.chunkSize ?? 200), 200);
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    this.horizon = config.horizon ?? getStellarServer();
  }

  /**
  * Runs a single sequential scanning pass from the persisted database cursor.
  */
  async scanOnce(handler: LedgerTransactionHandler): Promise<LedgerScannerResult> {
    let pages = 0;
    let transactions = 0;
    let cursor = (
      (await getEventSyncCursor(this.streamKey)) ?? INITIAL_SYNC_CURSOR
    );

    while (!this.stopped) {
      const response = await this.fetchPage(cursor);
      const records = response.records ?? [];

      if (records.length === 0) break;

      for (const tx of records) {
        await handler(tx);
        transactions++;
      }

      const lastRecord = records[records.length - 1];
      cursor = lastRecord.paging_token ?? cursor;
      
      // Persist last scanned cursor in database to prevent duplicates and handle reconnects
      await setEventSyncCursor(this.streamKey, cursor);
      pages++;

      // If records fetched are less than chunk size, we have reached the tip of the ledger
      if (records.length < this.chunkSize) break;
    }

    return { pages, transactions };
  }

  /**
   * Starts the continuous ledger scanning loop.
   */
  start(handler: LedgerTransactionHandler): void {
    if (this.pollTimer) return;

    this.stopped = false;
    void this.runLoop(handler);

    this.pollTimer = setInterval(() => {
      void this.runLoop(handler);
    }, this.pollIntervalMs);
  }

  /**
   * Stops the ledger scanning loop.
   */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async runLoop(handler: LedgerTransactionHandler): Promise<void> {
    if (this.stopped) return;
    try {
      await this.scanOnce(handler);
    } catch (error) {
      logger.error(
        `Ledger scanner failed for stream "${this.streamKey}":`,
        error,
      );
    }
  }

  private fetchPage(cursor: string): Promise<any> {
    let call = this.horizon.transactions();
    
    if (this.contractId) {
      call = call.forAccount(this.contractId);
    }

    return call
      .limit(this.chunkSize)
      .order("asc")
      .cursor(cursor)
      .call();
  }
}
