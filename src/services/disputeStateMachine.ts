import { DisputeStatus, DisputePriority } from "../models/dispute";

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
  }

  /**
   * Check if a state transition is valid
   */
  isValidTransition(from: DisputeStatus, to: DisputeStatus): boolean {
    return this.config.transitions.some(
      (transition) => transition.from === from && transition.to === to
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
      (t) => t.from === from && t.to === to
    );
    return transition?.requiredFields || [];
  }

  /**
   * Get conditions for a specific transition
   */
  getTransitionConditions(from: DisputeStatus, to: DisputeStatus): string[] {
    const transition = this.config.transitions.find(
      (t) => t.from === from && t.to === to
    );
    return transition?.conditions || [];
  }

  /**
   * Validate a state transition with data
   */
  validateTransition(
    from: DisputeStatus,
    to: DisputeStatus,
    data: Record<string, any> = {}
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check if transition is allowed
    if (!this.isValidTransition(from, to)) {
      const allowed = this.getAllowedTransitions(from);
      errors.push(
        `Cannot transition from "${from}" to "${to}". ` +
        (allowed.length 
          ? `Allowed transitions: ${allowed.join(", ")}`
          : `"${from}" is a terminal state.`)
      );
    }

    // Check required fields
    const requiredFields = this.getRequiredFields(from, to);
    for (const field of requiredFields) {
      if (!data[field] || (typeof data[field] === 'string' && data[field].trim() === '')) {
        errors.push(`Field "${field}" is required for transition to "${to}"`);
      }
    }

    // Additional business rule validations
    if (to === "investigating" && !data.assignedTo) {
      errors.push("Dispute must be assigned to an agent when moving to investigating status");
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
    }
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
    const slaDeadline = new Date(createdAt.getTime() + slaHours * 60 * 60 * 1000);
    return new Date() > slaDeadline;
  }

  /**
   * Get time remaining until SLA deadline
   */
  getTimeUntilSlaDeadline(createdAt: Date, priority: DisputePriority): {
    hours: number;
    isOverdue: boolean;
  } {
    const slaHours = this.getSlaHours(priority);
    const slaDeadline = new Date(createdAt.getTime() + slaHours * 60 * 60 * 1000);
    const now = new Date();
    const diffMs = slaDeadline.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    return {
      hours: Math.round(diffHours * 100) / 100,
      isOverdue: diffHours < 0,
    };
  }
}
