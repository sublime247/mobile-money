/**
 * M-Pesa STK push query polling (#1969).
 *
 * Safaricom's `Lipa Na M-Pesa Online` (STK push) flow is asynchronous: the
 * result normally arrives on the `CallBackURL` we registered. Some handsets,
 * however, silently dismiss the SIM-toolkit prompt without ever posting a
 * callback. When that happens the transaction sits in `pending` forever.
 *
 * This module closes that gap by polling the `stkpushquery` endpoint a fixed
 * number of seconds after the STK push is initiated, mapping Safaricom's raw
 * `ResultCode` to a precise transaction state, and notifying the user.
 *
 * Key result codes (see {@link MPESA_STK_RESULT_CODES}):
 *   - 0    Success
 *   - 1032 Request cancelled by user
 *   - 1037 Handset/DS timeout — no response from the subscriber
 */

import { recordUssdPushOutcome } from "../../monitoring/metrics";
import logger from "../../utils/logger";
import { MpesaProvider, MpesaStkQueryResult } from "./mpesaService";
import { TransactionModel, TransactionStatus } from "../../models/transaction";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Wait this long for the callback before falling back to query polling. */
export const STK_CALLBACK_TIMEOUT_MS = 30_000;
/** Delay between successive query attempts once polling has started. */
export const STK_QUERY_POLL_INTERVAL_MS = 5_000;
/** Hard cap on query attempts so a stuck transaction is always resolved. */
export const STK_QUERY_MAX_ATTEMPTS = 6;

// ─── Result code mapping ────────────────────────────────────────────────────

export type MpesaStkResolutionStatus =
  | "completed"
  | "cancelled"
  | "expired"
  | "failed"
  | "pending";

export interface MpesaStkResolution {
  status: MpesaStkResolutionStatus;
  /** Internal transaction state to persist when the resolution is terminal. */
  transactionStatus: TransactionStatus;
  /** `true` once no further polling can change the outcome. */
  terminal: boolean;
  /** Human-readable message suitable for SMS/push/WhatsApp notification. */
  userMessage: string;
  resultCode?: number;
  resultDesc?: string;
}

interface MpesaStkCodeMapping {
  status: Exclude<MpesaStkResolutionStatus, "pending">;
  userMessage: string;
}

/**
 * Safaricom STK result codes → internal state. Codes not present here fall
 * back to a generic failure so an unexpected code can never leave a
 * transaction pending indefinitely.
 */
export const MPESA_STK_RESULT_CODES: Record<number, MpesaStkCodeMapping> = {
  0: {
    status: "completed",
    userMessage:
      "Payment received. Your wallet will be credited shortly.",
  },
  1: {
    status: "failed",
    userMessage: "Payment failed: insufficient M-Pesa balance.",
  },
  17: {
    status: "failed",
    userMessage: "Payment failed: the transaction could not be completed.",
  },
  1001: {
    status: "failed",
    userMessage:
      "A transaction is already in progress on this line. Please try again.",
  },
  1019: {
    status: "expired",
    userMessage: "The M-Pesa prompt expired before it was authorised.",
  },
  1025: {
    status: "failed",
    userMessage:
      "Payment failed due to a Safaricom system error. Please retry.",
  },
  1032: {
    status: "cancelled",
    userMessage:
      "You cancelled the M-Pesa prompt. No amount was deducted.",
  },
  1037: {
    status: "expired",
    userMessage:
      "The M-Pesa prompt timed out without a response. Please retry.",
  },
  1050: {
    status: "failed",
    userMessage:
      "Another M-Pesa transaction is being processed. Please retry shortly.",
  },
  2001: {
    status: "failed",
    userMessage: "Payment failed: incorrect M-Pesa PIN entered.",
  },
  9999: {
    status: "failed",
    userMessage:
      "Payment failed: the request could not be processed by Safaricom.",
  },
};

/**
 * Map a raw Safaricom result code to an internal resolution.
 * An unknown (non-zero) code is treated as a terminal failure rather than
 * leaving the transaction pending forever.
 */
export function resolveMpesaStkResult(
  resultCode: number | undefined,
  resultDesc?: string,
): MpesaStkResolution {
  if (resultCode === undefined) {
    return {
      status: "pending",
      transactionStatus: TransactionStatus.Pending,
      terminal: false,
      userMessage: "Your M-Pesa payment is still being processed.",
      resultDesc,
    };
  }

  const mapping = MPESA_STK_RESULT_CODES[resultCode];
  if (mapping) {
    return {
      status: mapping.status,
      transactionStatus: toTransactionStatus(mapping.status),
      terminal: true,
      userMessage: mapping.userMessage,
      resultCode,
      resultDesc,
    };
  }

  return {
    status: "failed",
    transactionStatus: TransactionStatus.Failed,
    terminal: true,
    userMessage:
      "Payment failed: the request could not be processed by M-Pesa.",
    resultCode,
    resultDesc,
  };
}

/**
 * Resolve a full `stkpushquery` response. A transport error (`success: false`)
 * or a missing `ResultCode` means Safaricom is still working on the request,
 * so the caller should keep polling.
 */
export function resolveMpesaStkQuery(
  query: MpesaStkQueryResult,
): MpesaStkResolution {
  if (!query.success) {
    return {
      status: "pending",
      transactionStatus: TransactionStatus.Pending,
      terminal: false,
      userMessage: "Your M-Pesa payment is still being processed.",
    };
  }
  return resolveMpesaStkResult(query.resultCode, query.resultDesc);
}

function toTransactionStatus(
  status: MpesaStkResolutionStatus,
): TransactionStatus {
  switch (status) {
    case "completed":
      return TransactionStatus.Completed;
    case "cancelled":
      return TransactionStatus.Cancelled;
    case "expired":
      return TransactionStatus.Expired;
    case "failed":
      return TransactionStatus.Failed;
    default:
      return TransactionStatus.Pending;
  }
}

// ─── Poller ─────────────────────────────────────────────────────────────────

export interface MpesaStkQueryTarget {
  /** Internal transaction id (uuid). */
  transactionId: string;
  /** Safaricom `CheckoutRequestID` returned by `initiateStkPush`. */
  checkoutRequestId: string;
  userId?: string | null;
  phoneNumber?: string;
  amount?: number;
  /**
   * Override the default {@link STK_CALLBACK_TIMEOUT_MS} delay before the
   * first query — used by tests and for provider-specific tuning.
   */
  delayMs?: number;
}

export interface MpesaStkQueryNotification {
  transactionId: string;
  checkoutRequestId: string;
  userId?: string | null;
  phoneNumber?: string;
  status: MpesaStkResolutionStatus;
  transactionStatus: TransactionStatus;
  message: string;
  resultCode?: number;
  resultDesc?: string;
}

export interface MpesaStkQueryPollerOptions {
  /** Injectable for tests — defaults to a real {@link MpesaProvider}. */
  provider?: Pick<MpesaProvider, "queryStkPush">;
  /** Injectable for tests — defaults to a real {@link TransactionModel}. */
  transactionModel?: Pick<TransactionModel, "updateStatus">;
  /** Called once a terminal outcome has been persisted. */
  notifyUser?: (
    notification: MpesaStkQueryNotification,
  ) => void | Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  /** Injectable sleep, allowing fake timers in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Do not keep the process alive merely to poll a provider.
    timer.unref?.();
  });

/**
 * Schedules and executes STK-push query polling for pending transactions.
 *
 * Typical lifecycle:
 *   `schedule(target)`         -> arms a 30s timer when STK push is initiated
 *   <callback arrives>         -> `cancel(checkoutRequestId)` (no polling)
 *   <timer fires>              -> `poll(target)` queries and resolves
 */
export class MpesaStkQueryPoller {
  private readonly provider: Pick<MpesaProvider, "queryStkPush">;
  private readonly transactionModel: Pick<
    TransactionModel,
    "updateStatus"
  >;
  private notifyUser?: (
    notification: MpesaStkQueryNotification,
  ) => void | Promise<void>;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly pending = new Map<
    string,
    { target: MpesaStkQueryTarget; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(options: MpesaStkQueryPollerOptions = {}) {
    this.provider = options.provider ?? new MpesaProvider();
    this.transactionModel = options.transactionModel ?? new TransactionModel();
    this.notifyUser = options.notifyUser;
    this.timeoutMs = options.timeoutMs ?? STK_CALLBACK_TIMEOUT_MS;
    this.pollIntervalMs =
      options.pollIntervalMs ?? STK_QUERY_POLL_INTERVAL_MS;
    this.maxAttempts = options.maxAttempts ?? STK_QUERY_MAX_ATTEMPTS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Register (or replace) the handler invoked once a terminal outcome is persisted. */
  setNotificationHandler(
    handler: (notification: MpesaStkQueryNotification) => void | Promise<void>,
  ): void {
    this.notifyUser = handler;
  }

  /** Checkout request IDs currently awaiting a callback or query result. */
  getPendingCheckoutRequestIds(): string[] {
    return Array.from(this.pending.keys());
  }

  isTracking(checkoutRequestId: string): boolean {
    return this.pending.has(checkoutRequestId);
  }

  /** Tracked targets, for the callback route to resolve transaction ids. */
  getTrackedTargets(): Array<{
    checkoutRequestId: string;
    transactionId: string;
    userId?: string | null;
    phoneNumber?: string;
  }> {
    return Array.from(this.pending.values(), ({ target }) => ({
      checkoutRequestId: target.checkoutRequestId,
      transactionId: target.transactionId,
      userId: target.userId ?? null,
      phoneNumber: target.phoneNumber,
    }));
  }

  /**
   * Arm the callback timeout for an STK push that has just been initiated.
   * Replaces any existing timer for the same checkout request.
   */
  schedule(target: MpesaStkQueryTarget): void {
    this.cancel(target.checkoutRequestId);

    const delay = target.delayMs ?? this.timeoutMs;
    const timer = setTimeout(() => {
      this.pending.delete(target.checkoutRequestId);
      void this.poll(target).catch((error) => {
        logger.error(
          { error, checkoutRequestId: target.checkoutRequestId },
          "[MpesaStkQuery] Polling failed unexpectedly",
        );
      });
    }, delay);

    timer.unref?.();
    this.pending.set(target.checkoutRequestId, { target, timer });
  }

  /**
   * Stop tracking a checkout request — called when Safaricom's callback does
   * arrive, so the poller never races the callback.
   */
  cancel(checkoutRequestId: string): boolean {
    const entry = this.pending.get(checkoutRequestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(checkoutRequestId);
    return true;
  }

  /**
   * Query Safaricom until a terminal result is obtained (or the attempt cap is
   * reached) and persist + notify the outcome.
   */
  async poll(target: MpesaStkQueryTarget): Promise<MpesaStkResolution> {
    let resolution = resolveMpesaStkResult(undefined);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const query = await this.provider.queryStkPush(
        target.checkoutRequestId,
      );
      resolution = resolveMpesaStkQuery(query);

      logger.debug(
        {
          checkoutRequestId: target.checkoutRequestId,
          attempt,
          resultCode: query.resultCode,
          status: resolution.status,
        },
        "[MpesaStkQuery] Query attempt complete",
      );

      if (resolution.terminal) {
        break;
      }

      if (attempt < this.maxAttempts) {
        await this.sleep(this.pollIntervalMs);
      }
    }

    if (!resolution.terminal) {
      // Callback never arrived and the query never produced a definitive
      // answer — expire the transaction rather than leaving it pending.
      resolution = {
        status: "expired",
        transactionStatus: TransactionStatus.Expired,
        terminal: true,
        userMessage:
          "M-Pesa did not confirm your payment in time. No amount was deducted.",
      };
    }

    recordUssdPushOutcome(
      "mpesa",
      "KE",
      target.checkoutRequestId,
      resolution.status === "completed"
        ? "success"
        : resolution.status === "expired"
          ? "timeout"
          : "failed",
    );
    await this.finalize(target, resolution);
    return resolution;
  }

  /** Persist the terminal state and inform the user. */
  private async finalize(
    target: MpesaStkQueryTarget,
    resolution: MpesaStkResolution,
  ): Promise<void> {
    try {
      await this.transactionModel.updateStatus(
        target.transactionId,
        resolution.transactionStatus,
        target.userId ?? undefined,
      );
    } catch (error) {
      logger.error(
        { error, transactionId: target.transactionId },
        "[MpesaStkQuery] Failed to persist transaction status",
      );
    }

    this.cancel(target.checkoutRequestId);

    if (!this.notifyUser) return;

    try {
      await this.notifyUser({
        transactionId: target.transactionId,
        checkoutRequestId: target.checkoutRequestId,
        userId: target.userId,
        phoneNumber: target.phoneNumber,
        status: resolution.status,
        transactionStatus: resolution.transactionStatus,
        message: resolution.userMessage,
        resultCode: resolution.resultCode,
        resultDesc: resolution.resultDesc,
      });
    } catch (error) {
      logger.error(
        { error, transactionId: target.transactionId },
        "[MpesaStkQuery] Failed to notify user",
      );
    }
  }
}
