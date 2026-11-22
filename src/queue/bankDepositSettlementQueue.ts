import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const BANK_DEPOSIT_SETTLEMENT_QUEUE_NAME = "bank-deposit-settlement";

export interface BankDepositSettlementJobData {
  /** sep24_transactions.id of the deposit whose fiat leg was confirmed. */
  depositId: string;
  /** bank_statement_lines.id that confirmed the deposit. */
  bankStatementLineId?: string;
}

export const bankDepositSettlementQueue =
  new Queue<BankDepositSettlementJobData>(BANK_DEPOSIT_SETTLEMENT_QUEUE_NAME, {
    ...queueOptions,
    defaultJobOptions: {
      ...queueOptions.defaultJobOptions,
      // A Stellar payment must never be blindly retried: a failed submission
      // may still land on-chain, so an automatic retry could pay twice.
      attempts: 1,
    },
  });

/**
 * Queues the on-chain token transfer for a bank-confirmed deposit. The job id
 * is derived from the deposit so it can only ever be queued once.
 */
export async function enqueueBankDepositSettlement(
  data: BankDepositSettlementJobData,
) {
  return bankDepositSettlementQueue.add("settle-deposit", data, {
    jobId: `bank-deposit-${data.depositId}`,
  });
}
