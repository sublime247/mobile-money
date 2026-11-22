/**
 * M-Pesa STK push query polling worker (#1969).
 *
 * Thin, startable wrapper around {@link MpesaStkQueryPoller}. The transaction
 * pipeline calls {@link MpesaStkQueryWorker.onStkPushInitiated} as soon as an
 * STK push is accepted by Safaricom, and the webhook controller calls
 * {@link MpesaStkQueryWorker.onStkCallback} when the callback actually lands.
 *
 *   - Callback within 30s  -> poller tracking cancelled, callback wins.
 *   - No callback in 30s   -> `stkpushquery` is polled until a terminal
 *                             result code is mapped (including 1032/1037).
 */

import logger from "../utils/logger";
import {
  MpesaStkQueryNotification,
  MpesaStkQueryPoller,
  MpesaStkQueryPollerOptions,
  MpesaStkQueryTarget,
  MpesaStkResolution,
} from "../services/providers/mpesaStkQuery";

export interface MpesaStkQueryWorkerStats {
  running: boolean;
  scheduled: number;
  cancelledByCallback: number;
  processed: number;
  active: number;
}

export class MpesaStkQueryWorker {
  private readonly poller: MpesaStkQueryPoller;
  private running = false;

  private scheduled = 0;
  private cancelledByCallback = 0;
  private processed = 0;

  constructor(
    options: MpesaStkQueryPollerOptions & { autostart?: boolean } = {},
  ) {
    this.poller = new MpesaStkQueryPoller(options);
    if (options.autostart) {
      this.start();
    }
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    for (const checkoutRequestId of this.poller.getPendingCheckoutRequestIds()) {
      this.poller.cancel(checkoutRequestId);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getStats(): MpesaStkQueryWorkerStats {
    return {
      running: this.running,
      scheduled: this.scheduled,
      cancelledByCallback: this.cancelledByCallback,
      processed: this.processed,
      active: this.poller.getPendingCheckoutRequestIds().length,
    };
  }

  /**
   * Register an STK push that has just been initiated and arm the 30-second
   * callback timeout. Returns `true` when the request was armed.
   */
  onStkPushInitiated(target: MpesaStkQueryTarget): boolean {
    if (!this.running) {
      logger.debug(
        { checkoutRequestId: target.checkoutRequestId },
        "[MpesaStkQueryWorker] Worker stopped — not scheduling poll",
      );
      return false;
    }

    this.poller.schedule(target);
    this.scheduled += 1;

    logger.info(
      {
        transactionId: target.transactionId,
        checkoutRequestId: target.checkoutRequestId,
      },
      "[MpesaStkQueryWorker] Armed STK query fallback",
    );
    return true;
  }

  /**
   * Tracked STK pushes (checkout request id -> internal transaction target).
   * Used by the STK callback route to resolve the internal transaction id for
   * an incoming callback without touching the database.
   */
  getTrackedTargets(): Array<{
    checkoutRequestId: string;
    transactionId: string;
    userId?: string | null;
    phoneNumber?: string;
  }> {
    return this.poller.getTrackedTargets();
  }

  /** Cancel the fallback because Safaricom's callback arrived in time. */
  onStkCallback(checkoutRequestId: string): boolean {
    const cancelled = this.poller.cancel(checkoutRequestId);
    if (cancelled) {
      this.cancelledByCallback += 1;
    }
    return cancelled;
  }

  /** Query immediately (used by operators/tests to force resolution). */
  async processNow(target: MpesaStkQueryTarget): Promise<MpesaStkResolution> {
    const resolution = await this.poller.poll(target);
    this.processed += 1;
    return resolution;
  }

  /** Convenience hook for wiring the "inform user" step. */
  setNotificationHandler(
    handler: (notification: MpesaStkQueryNotification) => void | Promise<void>,
  ): void {
    this.poller.setNotificationHandler(handler);
  }
}

export const mpesaStkQueryWorker = new MpesaStkQueryWorker();
