import { EventEmitter } from "events";
import logger from "../utils/logger";
import {
  enqueueCustomerCallback,
  CustomerCallbackJobData,
} from "../queue/customerCallbackQueue";

export enum Sep12CustomerStatus {
  ACCEPTED = "ACCEPTED",
  PROCESSING = "PROCESSING",
  NEEDS_INFO = "NEEDS_INFO",
  REJECTED = "REJECTED",
}

export interface RegisteredClientCallback {
  id: string;
  customerId?: string;
  account?: string;
  callbackUrl: string;
  secret: string;
  events?: string[];
  isActive?: boolean;
  createdAt?: Date;
}

export interface CustomerStatusTransitionEvent {
  customerId: string;
  account?: string;
  previousStatus: string;
  currentStatus: string;
  reason?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface TransitionCustomerStatusParams {
  customerId: string;
  account?: string;
  previousStatus: string;
  currentStatus: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  callbackUrl?: string;
  callbackSecret?: string;
}

export interface CustomerTransitionResult {
  event: CustomerStatusTransitionEvent;
  dispatchedCallbacks: number;
}

// Global event emitter for customer events
export const customerEvents = new EventEmitter();

export class CustomerService {
  private clientCallbacks: Map<string, RegisteredClientCallback> = new Map();
  private enqueueFn: (data: CustomerCallbackJobData) => Promise<void>;

  constructor(options?: {
    enqueueFn?: (data: CustomerCallbackJobData) => Promise<void>;
  }) {
    this.enqueueFn = options?.enqueueFn || enqueueCustomerCallback;
  }

  /**
   * Register a client webhook callback URL for KYC status updates.
   */
  registerClientCallback(callback: RegisteredClientCallback): void {
    const id = callback.id || `cb-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    this.clientCallbacks.set(id, {
      ...callback,
      id,
      isActive: callback.isActive !== false,
      createdAt: callback.createdAt || new Date(),
    });
    logger.info(
      { callbackId: id, customerId: callback.customerId, account: callback.account },
      "[CustomerService] Registered client webhook callback",
    );
  }

  /**
   * Unregister a client webhook callback by ID.
   */
  unregisterClientCallback(id: string): boolean {
    return this.clientCallbacks.delete(id);
  }

  /**
   * Get all registered callbacks matching a customer ID or account.
   */
  getClientCallbacks(customerId: string, account?: string): RegisteredClientCallback[] {
    const matching: RegisteredClientCallback[] = [];
    for (const cb of this.clientCallbacks.values()) {
      if (!cb.isActive) continue;

      const matchesCustomer = cb.customerId && cb.customerId === customerId;
      const matchesAccount = account && cb.account && cb.account === account;
      const isWildcard = !cb.customerId && !cb.account;

      if (matchesCustomer || matchesAccount || isWildcard) {
        matching.push(cb);
      }
    }
    return matching;
  }

  /**
   * Clear all registered callbacks (primarily for testing).
   */
  clearCallbacks(): void {
    this.clientCallbacks.clear();
  }

  /**
   * Status transition hook listeners
   */
  onStatusTransition(listener: (event: CustomerStatusTransitionEvent) => void): this {
    customerEvents.on("customer:status_changed", listener);
    return this;
  }

  onApproved(listener: (event: CustomerStatusTransitionEvent) => void): this {
    customerEvents.on("customer:accepted", listener);
    return this;
  }

  onRejected(listener: (event: CustomerStatusTransitionEvent) => void): this {
    customerEvents.on("customer:rejected", listener);
    return this;
  }

  /**
   * Transition customer KYC status, emit internal events, and dispatch webhooks to background queue.
   */
  async transitionCustomerStatus(
    params: TransitionCustomerStatusParams,
  ): Promise<CustomerTransitionResult> {
    const {
      customerId,
      account,
      previousStatus,
      currentStatus,
      reason,
      metadata = {},
      callbackUrl,
      callbackSecret,
    } = params;

    const transitionEvent: CustomerStatusTransitionEvent = {
      customerId,
      account,
      previousStatus,
      currentStatus,
      reason,
      timestamp: new Date(),
      metadata,
    };

    // 1. Emit internal event whenever customer status transitions between KYC states
    customerEvents.emit("customer:status_changed", transitionEvent);
    customerEvents.emit("kyc.status_transition", transitionEvent);

    const normalizedStatus = currentStatus.toLowerCase();
    if (normalizedStatus === "accepted" || normalizedStatus === "approved") {
      customerEvents.emit("customer:accepted", transitionEvent);
    } else if (normalizedStatus === "rejected") {
      customerEvents.emit("customer:rejected", transitionEvent);
    }

    logger.info(
      { customerId, account, previousStatus, currentStatus },
      `[CustomerService] Customer KYC status transitioned from ${previousStatus} to ${currentStatus}`,
    );

    // 2. Resolve target callback endpoints
    const targetCallbacks = this.getClientCallbacks(customerId, account);

    // If an ad-hoc callback was passed directly in params, include it
    if (callbackUrl) {
      targetCallbacks.push({
        id: `adhoc-${Date.now()}`,
        customerId,
        account,
        callbackUrl,
        secret: callbackSecret || process.env.STELLAR_WEBHOOK_SECRET || "default_webhook_secret",
        isActive: true,
      });
    }

    // 3. Trigger registered client webhook callbacks with updated customer status payload & HMAC
    let dispatchedCount = 0;
    const nowTimestamp = Math.floor(Date.now() / 1000);

    for (const cb of targetCallbacks) {
      const payload: Record<string, unknown> = {
        event: `customer.kyc.${normalizedStatus}`,
        event_id: `evt-${customerId}-${normalizedStatus}-${Date.now()}`,
        customer_id: customerId,
        account: account || null,
        previous_status: previousStatus,
        current_status: currentStatus,
        status: currentStatus,
        reason: reason || null,
        timestamp: transitionEvent.timestamp.toISOString(),
        metadata,
      };

      const jobData: CustomerCallbackJobData = {
        customerId,
        account,
        status: currentStatus,
        previousStatus,
        callbackUrl: cb.callbackUrl,
        secret: cb.secret || process.env.STELLAR_WEBHOOK_SECRET || "default_webhook_secret",
        payload,
        timestamp: nowTimestamp,
      };

      try {
        await this.enqueueFn(jobData);
        dispatchedCount++;
      } catch (err: any) {
        logger.error(
          { customerId, callbackUrl: cb.callbackUrl, error: err.message },
          "[CustomerService] Failed to dispatch webhook callback to background queue",
        );
      }
    }

    return {
      event: transitionEvent,
      dispatchedCallbacks: dispatchedCount,
    };
  }

  /**
   * Helper to map KYC service statuses (pending/approved/rejected) to SEP-12 statuses
   * and execute status transition hook.
   */
  async handleKycStatusChange(
    customerId: string,
    newKycStatus: string,
    previousKycStatus: string = "PENDING",
    reason?: string,
    account?: string,
  ): Promise<CustomerTransitionResult> {
    let sep12Status = Sep12CustomerStatus.PROCESSING;
    const upper = newKycStatus.toUpperCase();

    if (upper === "APPROVED" || upper === "ACCEPTED") {
      sep12Status = Sep12CustomerStatus.ACCEPTED;
    } else if (upper === "REJECTED") {
      sep12Status = Sep12CustomerStatus.REJECTED;
    } else if (upper === "NEEDS_INFO") {
      sep12Status = Sep12CustomerStatus.NEEDS_INFO;
    }

    let prevSep12Status = Sep12CustomerStatus.PROCESSING;
    const prevUpper = previousKycStatus.toUpperCase();
    if (prevUpper === "APPROVED" || prevUpper === "ACCEPTED") {
      prevSep12Status = Sep12CustomerStatus.ACCEPTED;
    } else if (prevUpper === "REJECTED") {
      prevSep12Status = Sep12CustomerStatus.REJECTED;
    } else if (prevUpper === "NEEDS_INFO") {
      prevSep12Status = Sep12CustomerStatus.NEEDS_INFO;
    }

    return this.transitionCustomerStatus({
      customerId,
      account,
      previousStatus: prevSep12Status,
      currentStatus: sep12Status,
      reason,
    });
  }
}

export const defaultCustomerService = new CustomerService();
export default defaultCustomerService;
