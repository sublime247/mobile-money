import { TransactionModel } from "../models/transaction";
export const MIN_WITHDRAWAL_AMOUNT = 1;
export class TransactionService {
  constructor(private txModel: TransactionModel) {}

  async findByUserId(userId: string) {
    return await this.txModel.findByUserId(userId);
  }

  // ============================================================================
  // WITHDRAWAL LOGIC
  // ============================================================================
  async withdraw(payload: { userId: string; amount: number; currency: string; [key: string]: any }) {
    // Enforce a strict minimum of $1 to prevent micro-transaction gas/fee losses.
    if (payload.amount < 1) {
      throw new Error('Amount too small');
    }

    // TODO: Proceed with the rest of the withdrawal logic using this.txModel
    // e.g., return await this.txModel.createTransaction({ ...payload, type: 'WITHDRAWAL' });
  }
}