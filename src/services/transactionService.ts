import logger from "../utils/logger.js";
import { TransactionModel, TransactionStatus } from "../models/transaction.js";
import { queryWrite } from "../config/database.js";

export const MIN_WITHDRAWAL_AMOUNT = 1;

export class TransactionService {
  constructor(private txModel: TransactionModel) {}

  async findByUserId(userId: string) {
    return await this.txModel.findByUserId(userId);
  }

  // ============================================================================
  // WITHDRAWAL LOGIC
  // ============================================================================
  async withdraw(payload: {
    userId: string;
    amount: number;
    currency: string;
    [key: string]: any;
  }) {
    // Enforce a strict minimum of $1 to prevent micro-transaction gas/fee losses.
    if (payload.amount < 1) {
      throw new Error("Amount too small");
    }

    // TODO: Proceed with the rest of the withdrawal logic using this.txModel
    // e.g., return await this.txModel.createTransaction({ ...payload, type: 'WITHDRAWAL' });
  }

  // ============================================================================
  // TRANSACTION HOLD — issue #2470
  // Places a transaction on compliance hold for officer review when AML
  // smurfing_velocity or structuring rules are triggered.
  // ============================================================================

  /**
   * Place a transaction on compliance hold.
   *
   * Sets the transaction status to `review` and records the AML alert ID
   * and reason in the metadata for the compliance officer's queue.
   *
   * @param transactionId   UUID of the transaction to hold
   * @param alertId         AML alert ID that triggered the hold
   * @param reason          Human-readable reason for the hold
   */
  async holdForComplianceReview(
    transactionId: string,
    alertId: string,
    reason: string,
  ): Promise<void> {
    logger.warn(
      { transactionId, alertId, reason },
      "[transactionService] Placing transaction on compliance hold",
    );

    await queryWrite(
      `UPDATE transactions
          SET status     = $1,
              admin_notes = COALESCE(admin_notes || E'\n', '') || $2,
              updated_at  = NOW()
        WHERE id = $3
          AND status NOT IN ('completed', 'cancelled', 'reversed', 'clawed_back')`,
      [
        TransactionStatus.Review,
        `[AML HOLD] alertId=${alertId} reason=${reason}`,
        transactionId,
      ],
    );
  }

  /**
   * Release a compliance hold, returning the transaction to `pending`.
   * Should only be called by a compliance officer after review.
   *
   * @param transactionId   UUID of the transaction
   * @param reviewedBy      Officer's user ID
   * @param notes           Review notes
   */
  async releaseComplianceHold(
    transactionId: string,
    reviewedBy: string,
    notes: string,
  ): Promise<void> {
    logger.info(
      { transactionId, reviewedBy },
      "[transactionService] Releasing compliance hold",
    );

    await queryWrite(
      `UPDATE transactions
          SET status     = $1,
              admin_notes = COALESCE(admin_notes || E'\n', '') || $2,
              updated_at  = NOW()
        WHERE id = $3
          AND status = $4`,
      [
        TransactionStatus.Pending,
        `[AML RELEASE] reviewedBy=${reviewedBy} notes=${notes}`,
        transactionId,
        TransactionStatus.Review,
      ],
    );
  }
}
