/**
 * DisputeService — Transaction Dispute Workflow
 *
 * Manages the full lifecycle of a transaction dispute:
 *
 *  Status transitions (allowed paths):
 *
 *    open ──→ investigating ──→ resolved
 *      │              │
 *      └──────────────┴──→ rejected
 *
 *  "resolved" and "rejected" are terminal states — no further transitions.
 *
 * Responsibilities:
 *   - Open disputes against completed or failed transactions
 *   - Enforce valid status transitions
 *   - Add timestamped notes / comments
 *   - Assign disputes to support agents
 *   - Send (logged) notifications on every status change
 *   - Generate aggregate reports filtered by date range or assignee
 */

import {
  DisputeModel,
  Dispute,
  DisputeNote,
  DisputeWithNotes,
  DisputeWithDetails,
  DisputeEvidence,
  DisputeReportRow,
  DisputeStatus,
  DisputePriority,
  ReportFilter,
} from "../models/dispute";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Allowed status transitions
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  open: ["investigating", "resolved", "rejected", "reversed", "upheld"],
  investigating: ["resolved", "rejected", "reversed", "upheld"],
  resolved: [],
  rejected: [],
  reversed: [],
  upheld: [],
};

const TERMINAL_STATUSES: DisputeStatus[] = [
  "resolved",
  "rejected",
  "reversed",
  "upheld",
];

export type DisputeResolutionAction = "reverse" | "uphold";

// ---------------------------------------------------------------------------
// Notification helper
// Replace the body of `sendNotification` with your email / SMS / webhook
// integration (e.g. SendGrid, Twilio, internal event bus) without changing
// any callers.
// ---------------------------------------------------------------------------

interface NotificationPayload {
  event: string;
  disputeId: string;
  transactionId: string;
  status: DisputeStatus;
  message: string;
  metadata?: Record<string, unknown>;
}

async function sendNotification(payload: NotificationPayload): Promise<void> {
  // Import notification router service for proper multi-channel delivery
  const { notificationRouter } = await import("./notificationRouter.js");
  
  try {
    // Use notification router to send via email, SMS, webhook as configured
    await notificationRouter.sendDisputeNotification({
      disputeId: payload.disputeId,
      transactionId: payload.transactionId,
      event: payload.event,
      status: payload.status,
      message: payload.message,
      metadata: payload.metadata,
    });
    
    logger.info(
      {
        event: payload.event,
        disputeId: payload.disputeId,
        transactionId: payload.transactionId,
        status: payload.status,
      },
      'Dispute notification sent'
    );
  } catch (error) {
    logger.error(
      {
        error,
        disputeId: payload.disputeId,
        event: payload.event,
      },
      'Failed to send dispute notification'
    );
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DisputeService {
  private disputeModel = new DisputeModel();
  private transactionModel = new TransactionModel();

  /**
   * Open a new dispute for a transaction.
   *
   * Rules:
   * - Transaction must exist.
   * - No other active (open / investigating) dispute may exist for the same transaction.
   *
   * @param transactionId  UUID of the target transaction.
   * @param reason         Human-readable description of the issue.
   * @param reportedBy     Identifier of the person raising the dispute (optional).
   * @param priority       Priority level (optional, defaults to 'medium').
   * @param category       Dispute category (optional).
   */
  async openDispute(
    transactionId: string,
    reason: string,
    reportedBy?: string,
    priority?: DisputePriority,
    category?: string,
  ): Promise<Dispute> {
    const transaction = await this.transactionModel.findById(transactionId);
    if (!transaction) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    if (
      transaction.status !== TransactionStatus.Completed &&
      transaction.status !== TransactionStatus.Failed
    ) {
      throw new Error(
        `Disputes are only allowed for completed or failed transactions (current status: ${transaction.status})`,
      );
    }

    const existing =
      await this.disputeModel.findActiveByTransactionId(transactionId);
    if (existing) {
      throw new Error(
        `An active dispute (${existing.id}) already exists for transaction ${transactionId}`,
      );
    }

    const dispute = await this.disputeModel.create({
      transactionId,
      reason,
      reportedBy,
      priority,
      category,
    });

    await this.transactionModel.updateStatus(
      transactionId,
      TransactionStatus.Dispute,
    );

    sendNotification({
      event: "dispute.opened",
      disputeId: dispute.id,
      transactionId: dispute.transactionId,
      status: dispute.status,
      message: `Dispute opened for transaction ${transactionId}`,
      metadata: { reason, reportedBy, priority: dispute.priority, category },
    });

    return dispute;
  }

  /**
   * Retrieve a dispute by ID, including all notes.
   */
  async getDispute(disputeId: string): Promise<DisputeWithNotes> {
    const dispute = await this.disputeModel.findByIdWithNotes(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }
    return dispute;
  }

  /**
   * Retrieve a dispute by ID with full details (notes, evidence, timeline).
   */
  async getDisputeWithDetails(disputeId: string): Promise<DisputeWithDetails> {
    const dispute = await this.disputeModel.findByIdWithDetails(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }
    return dispute;
  }

  /**
   * Transition a dispute to a new status.
   *
   * @param disputeId   UUID of the dispute.
   * @param newStatus   Target status.
   * @param resolution  Required text when resolving or rejecting.
   * @param assignedTo  Optionally (re-)assign to an agent during the transition.
   */
  async updateStatus(
    disputeId: string,
    newStatus: DisputeStatus,
    resolution?: string,
    assignedTo?: string,
  ): Promise<Dispute> {
    const dispute = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    const allowed = TRANSITIONS[dispute.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Cannot transition dispute from "${dispute.status}" to "${newStatus}". ` +
          (allowed.length
            ? `Allowed transitions: ${allowed.join(", ")}`
            : `"${dispute.status}" is a terminal state.`),
      );
    }

    if (TERMINAL_STATUSES.includes(newStatus) && !resolution) {
      throw new Error(
        `A resolution text is required when setting status to "${newStatus}"`,
      );
    }

    const updated = await this.disputeModel.update(disputeId, {
      status: newStatus,
      resolution,
      assignedTo,
    });

    sendNotification({
      event: `dispute.${newStatus}`,
      disputeId: updated.id,
      transactionId: updated.transactionId,
      status: updated.status,
      message: `Dispute ${disputeId} status changed to "${newStatus}"`,
      metadata: { previousStatus: dispute.status, resolution, assignedTo },
    });

    return updated;
  }

  /**
   * Resolve a disputed payment by reversing it for the customer or upholding it
   * for the merchant.
   */
  async resolvePayment(
    disputeId: string,
    action: DisputeResolutionAction,
    resolution: string,
    adminId?: string,
  ): Promise<Dispute> {
    if (!resolution || resolution.trim().length === 0) {
      throw new Error("Resolution text is required");
    }

    const dispute = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    if (TERMINAL_STATUSES.includes(dispute.status)) {
      throw new Error(`Cannot resolve a ${dispute.status} dispute`);
    }

    const nextDisputeStatus: DisputeStatus =
      action === "reverse" ? "reversed" : "upheld";
    const nextTransactionStatus =
      action === "reverse"
        ? TransactionStatus.Reversed
        : TransactionStatus.Completed;
    const trimmedResolution = resolution.trim();

    const updated = await this.disputeModel.update(disputeId, {
      status: nextDisputeStatus,
      resolution: trimmedResolution,
      assignedTo: adminId,
    });

    await this.transactionModel.updateStatus(
      dispute.transactionId,
      nextTransactionStatus,
    );

    await this.disputeModel.addNote(
      disputeId,
      adminId ?? "admin",
      `Admin ${action === "reverse" ? "reversed" : "upheld"} payment: ${trimmedResolution}`,
    );

    sendNotification({
      event: `dispute.payment_${action === "reverse" ? "reversed" : "upheld"}`,
      disputeId: updated.id,
      transactionId: updated.transactionId,
      status: updated.status,
      message: `Payment dispute ${disputeId} was ${nextDisputeStatus}`,
      metadata: {
        previousStatus: dispute.status,
        resolution: trimmedResolution,
        adminId,
        transactionStatus: nextTransactionStatus,
      },
    });

    return updated;
  }

  /**
   * Update dispute fields (priority, category, internal notes).
   *
   * @param disputeId      UUID of the dispute.
   * @param updates        Fields to update.
   */
  async updateDispute(
    disputeId: string,
    updates: {
      priority?: DisputePriority;
      category?: string;
      internalNotes?: string;
    },
  ): Promise<Dispute> {
    const dispute = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    const updated = await this.disputeModel.update(disputeId, updates);

    sendNotification({
      event: "dispute.updated",
      disputeId: updated.id,
      transactionId: updated.transactionId,
      status: updated.status,
      message: `Dispute ${disputeId} updated`,
      metadata: updates,
    });

    return updated;
  }

  /**
   * Add evidence attachment to a dispute.
   *
   * @param disputeId    UUID of the dispute.
   * @param fileName     Original file name.
   * @param fileType     MIME type.
   * @param fileSize     File size in bytes.
   * @param s3Key        S3 object key.
   * @param s3Url        S3 object URL.
   * @param uploadedBy   User who uploaded the file.
   * @param description  Optional description.
   */
  async addEvidence(
    disputeId: string,
    fileName: string,
    fileType: string,
    fileSize: number,
    s3Key: string,
    s3Url: string,
    uploadedBy: string,
    description?: string,
  ): Promise<DisputeEvidence> {
    const dispute = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    const evidence = await this.disputeModel.addEvidence(
      disputeId,
      fileName,
      fileType,
      fileSize,
      s3Key,
      s3Url,
      uploadedBy,
      description,
    );

    sendNotification({
      event: "dispute.evidence_added",
      disputeId: dispute.id,
      transactionId: dispute.transactionId,
      status: dispute.status,
      message: `Evidence "${fileName}" added to dispute ${disputeId}`,
      metadata: { fileName, fileType, fileSize, uploadedBy },
    });

    return evidence;
  }

  /**
   * Get all evidence for a dispute.
   */
  async getEvidence(disputeId: string): Promise<DisputeEvidence[]> {
    const dispute = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    return this.disputeModel.getEvidence(disputeId);
  }

  /**
   * Check for disputes approaching SLA deadline and send warnings.
   */
  async processSlaWarnings(): Promise<{ warningsSent: number }> {
    const candidates = await this.disputeModel.findSlaWarningCandidates();
    let warningsSent = 0;

    for (const dispute of candidates) {
      try {
        sendNotification({
          event: "dispute.sla_warning",
          disputeId: dispute.id,
          transactionId: dispute.transactionId,
          status: dispute.status,
          message: `Dispute ${dispute.id} is approaching SLA deadline`,
          metadata: {
            slaDueDate: dispute.slaDueDate,
            priority: dispute.priority,
            assignedTo: dispute.assignedTo,
          },
        });

        await this.disputeModel.markSlaWarningSent(dispute.id);
        warningsSent++;
      } catch (error) {
        console.error(`Failed to send SLA warning for dispute ${dispute.id}:`, error);
      }
    }

    return { warningsSent };
  }

  /**
   * Get overdue disputes.
   */
  async getOverdueDisputes(): Promise<Dispute[]> {
    return this.disputeModel.findOverdueDisputes();
  }

  /**
   * Assign a dispute to a support team member.
   * Automatically moves the dispute from "open" to "investigating" if it is
   * still in the initial state.
   *
   * @param disputeId  UUID of the dispute.
   * @param agentName  Name or identifier of the support agent.
   */
  async assignToAgent(disputeId: string, agentName: string): Promise<Dispute> {
    const dispute = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    if (TERMINAL_STATUSES.includes(dispute.status)) {
      throw new Error(`Cannot assign a ${dispute.status} dispute`);
    }

    let updated = await this.disputeModel.assign(disputeId, agentName);

    // Auto-advance open → investigating on first assignment
    if (updated.status === "open") {
      updated = await this.disputeModel.update(disputeId, {
        status: "investigating",
        assignedTo: agentName,
      });
    }

    sendNotification({
      event: "dispute.assigned",
      disputeId: updated.id,
      transactionId: updated.transactionId,
      status: updated.status,
      message: `Dispute ${disputeId} assigned to ${agentName}`,
      metadata: { agentName },
    });

    return updated;
  }

  /**
   * Add a note or comment to a dispute.
   *
   * @param disputeId  UUID of the dispute.
   * @param author     Name or identifier of the note author.
   * @param note       Note text.
   */
  async addNote(
    disputeId: string,
    author: string,
    note: string,
  ): Promise<DisputeNote> {
    const dispute = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    return this.disputeModel.addNote(disputeId, author, note);
  }

  /**
   * Generate an aggregate report of disputes.
   *
   * Returns counts grouped by status and average resolution time (in hours)
   * for terminal states (resolved / rejected).
   *
   * @param filter  Optional date range and/or assignee filter.
   */
  async generateReport(filter: ReportFilter = {}): Promise<{
    generatedAt: string;
    filter: ReportFilter;
    summary: DisputeReportRow[];
    totals: {
      total: number;
      open: number;
      investigating: number;
      resolved: number;
      rejected: number;
      reversed: number;
      upheld: number;
    };
  }> {
    const rows = await this.disputeModel.generateReport(filter);

    const totals = {
      total: 0,
      open: 0,
      investigating: 0,
      resolved: 0,
      rejected: 0,
      reversed: 0,
      upheld: 0,
    };
    for (const row of rows) {
      const count = parseInt(row.count, 10);
      totals.total += count;
      if (row.status in totals) {
        totals[row.status as keyof typeof totals] += count;
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      filter,
      summary: rows,
      totals,
    };
  }
}
