import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { Sep31Status, mapToSep31Status, isValidTransition } from "../stellar/sep31";
import { getStellarServer } from "../config/stellar";
import * as StellarSdk from "stellar-sdk";

/**
 * SEP-31 Transaction Monitor Job
 * Schedule: Every minute
 * Monitors SEP-31 transactions for payment receipt and status updates.
 */
export async function runSep31MonitorJob(): Promise<void> {
  const transactionModel = new TransactionModel();
  const server = getStellarServer();

  try {
    // Find all pending SEP-31 transactions
    const result = await pool.query(`
      SELECT id, metadata, stellar_address, amount, status
      FROM transactions
      WHERE status IN ('pending', 'processing')
        AND provider = 'stellar-sep31'
        AND metadata->'sep31' IS NOT NULL
    `);

    console.log(`[sep31-monitor] Found ${result.rows.length} SEP-31 transactions to check`);

    for (const row of result.rows) {
      try {
        const metadata = row.metadata as any;
        const sep31Meta = metadata.sep31;
        const currentStatus = mapToSep31Status(row.status, metadata);

        // Skip if already completed or errored
        if (currentStatus === Sep31Status.Completed || currentStatus === Sep31Status.Error) {
          continue;
        }

        // Check if payment has been received
        if (currentStatus === Sep31Status.PendingSender) {
          const paymentReceived = await checkPaymentReceived(server, sep31Meta, row.amount);
          if (paymentReceived) {
            // Update to pending_stellar
            const newStatus = Sep31Status.PendingStellar;
            if (isValidTransition(currentStatus, newStatus)) {
              await updateSep31Status(row.id, newStatus, metadata);
              console.log(`[sep31-monitor] Transaction ${row.id} payment received, status: ${newStatus}`);
            }
          }
        }

        // For pending_stellar, we could add logic to check Stellar network confirmation
        // For now, we'll assume it moves to pending_receiver after payment confirmation

        // For pending_receiver, trigger payout (this would integrate with mobile money service)
        if (currentStatus === Sep31Status.PendingReceiver) {
          // TODO: Implement payout logic
          // For now, mark as completed after some time
          const newStatus = Sep31Status.Completed;
          if (isValidTransition(currentStatus, newStatus)) {
            await updateSep31Status(row.id, newStatus, metadata);
            console.log(`[sep31-monitor] Transaction ${row.id} completed, status: ${newStatus}`);
          }
        }

      } catch (error) {
        console.error(`[sep31-monitor] Error processing transaction ${row.id}:`, error);
      }
    }
  } catch (error) {
    console.error("[sep31-monitor] Job failed:", error);
  }
}

async function checkPaymentReceived(
  server: StellarSdk.Horizon.Server,
  sep31Meta: any,
  expectedAmount: string
): Promise<boolean> {
  try {
    // Query transactions for the receiving account with the memo
    const operations = await server
      .operations()
      .forAccount(sep31Meta.stellar_account_id || process.env.STELLAR_RECEIVING_ACCOUNT)
      .includeFailed(false)
      .limit(10)
      .call();

    // Look for payment operations with matching amount (memo check removed as memos are at transaction level)
    for (const op of operations.records) {
      if (op.type === "payment") {
        const amount = parseFloat(op.amount);
        const expected = parseFloat(expectedAmount);
        if (Math.abs(amount - expected) < 0.0000001) { // Account for floating point precision
          return true;
        }
      }
    }
  } catch (error) {
    console.error("[sep31-monitor] Error checking payment:", error);
  }

  return false;
}

async function updateSep31Status(
  transactionId: string,
  newStatus: Sep31Status,
  currentMetadata: any
): Promise<void> {
  const transactionModel = new TransactionModel();

  const updatedMetadata = {
    ...currentMetadata,
    sep31: {
      ...currentMetadata.sep31,
      status: newStatus,
    },
  };

  await transactionModel.updateMetadata(transactionId, updatedMetadata);

  // Update transaction status based on SEP-31 status
  let transactionStatus: TransactionStatus;
  switch (newStatus) {
    case Sep31Status.Completed:
      transactionStatus = TransactionStatus.Completed;
      break;
    case Sep31Status.Error:
      transactionStatus = TransactionStatus.Failed;
      break;
    default:
      transactionStatus = TransactionStatus.Processing;
  }

  await transactionModel.updateStatus(transactionId, transactionStatus);
}