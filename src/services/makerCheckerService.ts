/**
 * Maker-checker (four-eyes) approval for high-value treasury withdrawals.
 *
 * A withdrawal whose USD value is at or above the threshold is not sent to the
 * multisig custody flow immediately. It is parked as PENDING_APPROVAL. A
 * distinct admin holding the TREASURY_ADMIN role must approve it before it is
 * released, and the initiating admin can never approve their own request.
 *
 * The store is an interface so production can persist requests (the default
 * in-memory store is per process and is not shared across instances).
 */

export const TREASURY_ADMIN_ROLE = "TREASURY_ADMIN";
export const DEFAULT_DUAL_APPROVAL_THRESHOLD_USD = 5_000;

export type TreasuryApprovalStatus =
  "PENDING_APPROVAL" | "APPROVED" | "CANCELLED";

export interface TreasuryApprovalRequest {
  id: string;
  status: TreasuryApprovalStatus;
  makerId: string;
  checkerId?: string;
  amountUsd: number;
  payload: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
  cancelReason?: string;
}

export type MakerCheckerErrorCode =
  | "NOT_FOUND"
  | "NOT_PENDING"
  | "SELF_APPROVAL"
  | "NOT_TREASURY_ADMIN"
  | "NOT_MAKER";

export class MakerCheckerError extends Error {
  constructor(
    readonly code: MakerCheckerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MakerCheckerError";
  }
}

export interface TreasuryApprovalStore {
  get(id: string): Promise<TreasuryApprovalRequest | null>;
  put(request: TreasuryApprovalRequest): Promise<void>;
}

export function createInMemoryApprovalStore(): TreasuryApprovalStore {
  const records = new Map<string, TreasuryApprovalRequest>();
  return {
    async get(id) {
      const record = records.get(id);
      return record ? { ...record } : null;
    },
    async put(request) {
      records.set(request.id, { ...request });
    },
  };
}

/** Threshold in USD, overridable with TREASURY_DUAL_APPROVAL_THRESHOLD_USD. */
export function getDualApprovalThresholdUsd(): number {
  const parsed = Number(process.env.TREASURY_DUAL_APPROVAL_THRESHOLD_USD);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_DUAL_APPROVAL_THRESHOLD_USD;
}

/** True when the withdrawal must go through maker-checker. Non-finite amounts fail closed. */
export function requiresDualApproval(
  amountUsd: number,
  thresholdUsd: number = getDualApprovalThresholdUsd(),
): boolean {
  if (!Number.isFinite(amountUsd)) return true;
  return amountUsd >= thresholdUsd;
}

export class MakerCheckerService {
  constructor(
    private readonly store: TreasuryApprovalStore = createInMemoryApprovalStore(),
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () =>
      `tap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
  ) {}

  /** Parks a withdrawal in PENDING_APPROVAL. The payload is executed only after approval. */
  async initiate(params: {
    makerId: string;
    amountUsd: number;
    payload: Record<string, unknown>;
  }): Promise<TreasuryApprovalRequest> {
    if (!params.makerId) {
      throw new MakerCheckerError("NOT_MAKER", "A maker identity is required");
    }
    const request: TreasuryApprovalRequest = {
      id: this.newId(),
      status: "PENDING_APPROVAL",
      makerId: params.makerId,
      amountUsd: params.amountUsd,
      payload: params.payload,
      createdAt: this.now().toISOString(),
    };
    await this.store.put(request);
    return { ...request };
  }

  /**
   * Approves a pending request. The checker must hold TREASURY_ADMIN and must
   * differ from the maker. Returns the approved request.
   */
  async approve(
    requestId: string,
    checker: { userId: string; roles: string[] },
  ): Promise<TreasuryApprovalRequest> {
    const request = await this.requireRequest(requestId);
    this.assertPending(request);

    if (!checker.roles.includes(TREASURY_ADMIN_ROLE)) {
      throw new MakerCheckerError(
        "NOT_TREASURY_ADMIN",
        `Approval requires the ${TREASURY_ADMIN_ROLE} role`,
      );
    }
    if (checker.userId === request.makerId) {
      throw new MakerCheckerError(
        "SELF_APPROVAL",
        "The initiating admin cannot approve their own withdrawal",
      );
    }

    const approved: TreasuryApprovalRequest = {
      ...request,
      status: "APPROVED",
      checkerId: checker.userId,
      resolvedAt: this.now().toISOString(),
    };
    await this.store.put(approved);
    return { ...approved };
  }

  /** Cancels a pending request. Only the maker may cancel their own request. */
  async cancel(
    requestId: string,
    actorId: string,
    reason: string,
  ): Promise<TreasuryApprovalRequest> {
    const request = await this.requireRequest(requestId);
    this.assertPending(request);

    if (actorId !== request.makerId) {
      throw new MakerCheckerError(
        "NOT_MAKER",
        "Only the initiating admin can cancel this withdrawal",
      );
    }

    const cancelled: TreasuryApprovalRequest = {
      ...request,
      status: "CANCELLED",
      cancelReason: reason,
      resolvedAt: this.now().toISOString(),
    };
    await this.store.put(cancelled);
    return { ...cancelled };
  }

  async getRequest(requestId: string): Promise<TreasuryApprovalRequest | null> {
    return this.store.get(requestId);
  }

  private async requireRequest(
    requestId: string,
  ): Promise<TreasuryApprovalRequest> {
    const request = await this.store.get(requestId);
    if (!request) {
      throw new MakerCheckerError(
        "NOT_FOUND",
        "Withdrawal approval request not found",
      );
    }
    return request;
  }

  private assertPending(request: TreasuryApprovalRequest): void {
    if (request.status !== "PENDING_APPROVAL") {
      throw new MakerCheckerError(
        "NOT_PENDING",
        `Request is already ${request.status.toLowerCase()}`,
      );
    }
  }
}

export const makerCheckerService = new MakerCheckerService();
