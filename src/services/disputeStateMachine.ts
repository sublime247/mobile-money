import { DisputeStatus, DisputePriority } from "../models/dispute";
import { queryRead, queryWrite } from "../config/database";
import { encrypt } from "../utils/encryption";
import { MobileMoneyService } from "./mobilemoney/mobileMoneyService";

let slaIntervalStarted = false;

function getSlaHoursHelper(priority: DisputePriority): number {
  switch (priority) {
    case "critical":
      return 4;
    case "high":
      return 24;
    case "medium":
      return 72;
    case "low":
      return 168;
    default:
      return 72;
  }
}

export async function checkSlaDeadlines() {
  // 1. Set SLA timelocks for new disputes (where sla_due_date is NULL)
  const untimelockedDisputes = await queryRead<any>(
    `SELECT id, priority, created_at AS "createdAt" FROM disputes WHERE sla_due_date IS NULL`,
  );

  for (const row of untimelockedDisputes.rows) {
    const slaHours = getSlaHoursHelper(row.priority);
    const slaDueDate = new Date(
      new Date(row.createdAt).getTime() + slaHours * 60 * 60 * 1000,
    );
    await queryWrite(`UPDATE disputes SET sla_due_date = $1 WHERE id = $2`, [
      slaDueDate,
      row.id,
    ]);
  }

  // 2. Find overdue active disputes (sla_due_date < NOW())
  const overdueDisputes = await queryRead<any>(
    `SELECT id, transaction_id AS "transactionId"
     FROM disputes
     WHERE status IN ('open', 'investigating')
       AND sla_due_date IS NOT NULL
       AND sla_due_date < NOW()`,
  );

  for (const dispute of overdueDisputes.rows) {
    // A. Transition status to 'resolved' and set resolution text
    const resolutionText =
      "Auto-resolved in favor of user: Provider response SLA deadline expired.";
    await queryWrite(
      `UPDATE disputes SET status = 'resolved', resolution = $1, updated_at = NOW() WHERE id = $2`,
      [resolutionText, dispute.id],
    );

    // B. Add encrypted system note about auto-resolution
    const resolutionNote =
      "Dispute auto-resolved by SLA Engine because provider response wasn't logged within the 72-hour SLA window.";
    await queryWrite(
      `INSERT INTO dispute_notes (dispute_id, author, note, created_at) VALUES ($1, $2, $3, NOW())`,
      [dispute.id, "system", encrypt(resolutionNote)],
    );

    // C. Retrieve transaction details
    const txResult = await queryRead<any>(
      `SELECT provider, phone_number AS "phoneNumber", amount::text AS amount FROM transactions WHERE id = $1`,
      [dispute.transactionId],
    );

    if (txResult.rows.length > 0) {
      const tx = txResult.rows[0];
      try {
        const mmService = new MobileMoneyService();
        const payoutResult = await mmService.sendPayout(
          tx.provider,
          tx.phoneNumber,
          tx.amount,
        );

        if (payoutResult.success) {
          const payoutNote = `Auto-payout executed successfully. Ref: ${(payoutResult.data as any)?.transactionId || "N/A"}`;
          await queryWrite(
            `INSERT INTO dispute_notes (dispute_id, author, note, created_at) VALUES ($1, $2, $3, NOW())`,
            [dispute.id, "system", encrypt(payoutNote)],
          );
        } else {
          const payoutNote = `Auto-payout execution failed. Error: ${JSON.stringify(payoutResult.error)}`;
          await queryWrite(
            `INSERT INTO dispute_notes (dispute_id, author, note, created_at) VALUES ($1, $2, $3, NOW())`,
            [dispute.id, "system", encrypt(payoutNote)],
          );
        }
      } catch (payoutErr: any) {
        const payoutNote = `Auto-payout failed with exception: ${payoutErr.message}`;
        await queryWrite(
          `INSERT INTO dispute_notes (dispute_id, author, note, created_at) VALUES ($1, $2, $3, NOW())`,
          [dispute.id, "system", encrypt(payoutNote)],
        );
      }
    }
  }
}

export function startSlaCheckWorker() {
  if (slaIntervalStarted) return;
  slaIntervalStarted = true;

  checkSlaDeadlines().catch((err) =>
    console.error("[DisputeSlaWorker] Error:", err),
  );

  const intervalMs = process.env.NODE_ENV === "test" ? 1000 : 3600000;
  const interval = setInterval(() => {
    checkSlaDeadlines().catch((err) =>
      console.error("[DisputeSlaWorker] Error:", err),
    );
  }, intervalMs);

  if (typeof interval.unref === "function") {
    interval.unref();
  }
}

/**
 * Dispute State Machine
 *
 * Manages valid state transitions and business rules for dispute workflow.
 *
 * State Flow:
 * open → investigating → resolved
 *   │           │
 *   └───────────┴─→ rejected
 *
 * Terminal states: resolved, rejected
 */

export interface StateTransition {
  from: DisputeStatus;
  to: DisputeStatus;
  conditions?: string[];
  requiredFields?: string[];
}

export interface StateMachineConfig {
  transitions: StateTransition[];
  terminalStates: DisputeStatus[];
  initialState: DisputeStatus;
}

// Define allowed state transitions
export const DISPUTE_TRANSITIONS: StateTransition[] = [
  {
    from: "open",
    to: "investigating",
    conditions: ["Must be assigned to an agent"],
  },
  {
    from: "open",
    to: "resolved",
    requiredFields: ["resolution"],
    conditions: ["Resolution text is required"],
  },
  {
    from: "open",
    to: "rejected",
    requiredFields: ["resolution"],
    conditions: ["Resolution text is required"],
  },
  {
    from: "open",
    to: "reversed",
    requiredFields: ["resolution"],
    conditions: ["Admin reversal requires resolution text"],
  },
  {
    from: "open",
    to: "upheld",
    requiredFields: ["resolution"],
    conditions: ["Admin uphold decision requires resolution text"],
  },
  {
    from: "investigating",
    to: "resolved",
    requiredFields: ["resolution"],
    conditions: ["Resolution text is required"],
  },
  {
    from: "investigating",
    to: "rejected",
    requiredFields: ["resolution"],
    conditions: ["Resolution text is required"],
  },
  {
    from: "investigating",
    to: "reversed",
    requiredFields: ["resolution"],
    conditions: ["Admin reversal requires resolution text"],
  },
  {
    from: "investigating",
    to: "upheld",
    requiredFields: ["resolution"],
    conditions: ["Admin uphold decision requires resolution text"],
  },
];

export const DISPUTE_STATE_MACHINE: StateMachineConfig = {
  transitions: DISPUTE_TRANSITIONS,
  terminalStates: ["resolved", "rejected", "reversed", "upheld"],
  initialState: "open",
};

/**
 * State Machine Service for Dispute Workflow
 */
export class DisputeStateMachine {
  private config: StateMachineConfig;

  constructor(config: StateMachineConfig = DISPUTE_STATE_MACHINE) {
    this.config = config;
    startSlaCheckWorker();
  }

  /**
   * Check if a state transition is valid
   */
  isValidTransition(from: DisputeStatus, to: DisputeStatus): boolean {
    return this.config.transitions.some(
      (transition) => transition.from === from && transition.to === to,
    );
  }

  /**
   * Get allowed transitions from a given state
   */
  getAllowedTransitions(from: DisputeStatus): DisputeStatus[] {
    return this.config.transitions
      .filter((transition) => transition.from === from)
      .map((transition) => transition.to);
  }

  /**
   * Check if a state is terminal (no further transitions allowed)
   */
  isTerminalState(state: DisputeStatus): boolean {
    return this.config.terminalStates.includes(state);
  }

  /**
   * Get required fields for a specific transition
   */
  getRequiredFields(from: DisputeStatus, to: DisputeStatus): string[] {
    const transition = this.config.transitions.find(
      (t) => t.from === from && t.to === to,
    );
    return transition?.requiredFields || [];
  }

  /**
   * Get conditions for a specific transition
   */
  getTransitionConditions(from: DisputeStatus, to: DisputeStatus): string[] {
    const transition = this.config.transitions.find(
      (t) => t.from === from && t.to === to,
    );
    return transition?.conditions || [];
  }

  /**
   * Validate a state transition with data
   */
  validateTransition(
    from: DisputeStatus,
    to: DisputeStatus,
    data: Record<string, any> = {},
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check if transition is allowed
    if (!this.isValidTransition(from, to)) {
      const allowed = this.getAllowedTransitions(from);
      errors.push(
        `Cannot transition from "${from}" to "${to}". ` +
          (allowed.length
            ? `Allowed transitions: ${allowed.join(", ")}`
            : `"${from}" is a terminal state.`),
      );
    }

    // Check required fields
    const requiredFields = this.getRequiredFields(from, to);
    for (const field of requiredFields) {
      if (
        !data[field] ||
        (typeof data[field] === "string" && data[field].trim() === "")
      ) {
        errors.push(`Field "${field}" is required for transition to "${to}"`);
      }
    }

    // Additional business rule validations
    if (to === "investigating" && !data.assignedTo) {
      errors.push(
        "Dispute must be assigned to an agent when moving to investigating status",
      );
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get next recommended state based on current state and context
   */
  getRecommendedNextState(
    currentState: DisputeStatus,
    context: {
      hasAssignee?: boolean;
      hasEvidence?: boolean;
      priority?: DisputePriority;
      daysSinceCreated?: number;
    },
  ): DisputeStatus | null {
    const { hasAssignee, hasEvidence, priority, daysSinceCreated } = context;

    switch (currentState) {
      case "open":
        // Auto-assign high/critical priority disputes to investigating
        if (hasAssignee && (priority === "high" || priority === "critical")) {
          return "investigating";
        }
        // If dispute is old and unassigned, might need escalation
        if (!hasAssignee && daysSinceCreated && daysSinceCreated > 7) {
          return "investigating"; // Force assignment
        }
        return hasAssignee ? "investigating" : null;

      case "investigating":
        // If sufficient evidence and investigation time, ready for resolution
        if (hasEvidence && daysSinceCreated && daysSinceCreated > 1) {
          return "resolved"; // Suggest resolution after investigation
        }
        return null;

      case "resolved":
      case "rejected":
      case "reversed":
      case "upheld":
        return null; // Terminal states

      default:
        return null;
    }
  }

  /**
   * Calculate SLA hours based on priority
   */
  getSlaHours(priority: DisputePriority): number {
    switch (priority) {
      case "critical":
        return 4;
      case "high":
        return 24;
      case "medium":
        return 72;
      case "low":
        return 168; // 7 days
      default:
        return 72;
    }
  }

  /**
   * Check if dispute is overdue based on SLA
   */
  isOverdue(createdAt: Date, priority: DisputePriority): boolean {
    const slaHours = this.getSlaHours(priority);
    const slaDeadline = new Date(
      createdAt.getTime() + slaHours * 60 * 60 * 1000,
    );
    return new Date() > slaDeadline;
  }

  /**
   * Get time remaining until SLA deadline
   */
  getTimeUntilSlaDeadline(
    createdAt: Date,
    priority: DisputePriority,
  ): {
    hours: number;
    isOverdue: boolean;
  } {
    const slaHours = this.getSlaHours(priority);
    const slaDeadline = new Date(
      createdAt.getTime() + slaHours * 60 * 60 * 1000,
    );
    const now = new Date();
    const diffMs = slaDeadline.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    return {
      hours: Math.round(diffHours * 100) / 100,
      isOverdue: diffHours < 0,
    };
  }
}
