import logger from "../utils/logger";
import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import {
  Sep31Status,
  mapToSep31Status,
  isValidTransition,
  matchPaymentByMemo,
  StellarPaymentRecord,
} from "../stellar/sep31";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";
import * as StellarSdk from "@stellar/stellar-sdk";
import { notifyReceivingAnchorStatus } from "../services/webhookService";

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
      SELECT id, metadata, stellar_address, amount, status, created_at
      FROM transactions
      WHERE status IN ('pending', 'processing')
        AND provider = 'stellar-sep31'
        AND metadata->'sep31' IS NOT NULL
    `);

    console.log(
      `[sep31-monitor] Found ${result.rows.length} SEP-31 transactions to check`,
    );

    for (const row of result.rows) {
      try {
        const metadata = row.metadata as any;
        const sep31Meta = metadata.sep31;
        const currentStatus = mapToSep31Status(row.status, metadata);

        // Skip if already completed or errored
        if (
          currentStatus === Sep31Status.Completed ||
          currentStatus === Sep31Status.Error
        ) {
          continue;
        }

        // Check if payment has been received
        if (currentStatus === Sep31Status.PendingSender) {
          const result = await checkPaymentReceived(
            server,
            sep31Meta,
            row.amount,
          );

          if (result.matched && result.memoValid) {
            // Update to pending_stellar
            const newStatus = Sep31Status.PendingStellar;
            if (isValidTransition(currentStatus, newStatus)) {
              await updateSep31Status(row.id, newStatus, metadata);
              console.log(
                `[sep31-monitor] Transaction ${row.id} payment received, status: ${newStatus}`,
              );
            }
          } else if (result.matched && !result.memoValid && result.payment) {
            // A payment of the right destination/asset/amount arrived, but
            // its memo doesn't match (or is missing) — reject and refund it
            // rather than silently crediting it to this transfer (#2369).
            const alreadyRefunded = Boolean(sep31Meta.refunded);
            if (!alreadyRefunded) {
              console.warn(
                `[sep31-monitor] Transaction ${row.id} received a payment with an invalid/missing memo (expected "${sep31Meta.memo}", got "${result.payment.memo ?? ""}"); refunding`,
              );
              await refundMismatchedPayment(row.id, metadata, result.payment);
              await updateSep31Status(row.id, Sep31Status.Error, metadata);
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
            await notifyReceivingAnchorStatus(row, newStatus, metadata);
            console.log(
              `[sep31-monitor] Transaction ${row.id} completed, status: ${newStatus}`,
            );
          }
        }
      } catch (error) {
        logger.error(
          `[sep31-monitor] Error processing transaction ${row.id}:`,
          error,
        );
      }
    }
  } catch (error) {
    logger.error("[sep31-monitor] Job failed:", error);
  }
}

interface PaymentCheckResult {
  matched: boolean;
  memoValid: boolean;
  payment: StellarPaymentRecord | null;
}

/**
 * Checks whether the receiving account has an incoming payment matching
 * this SEP-31 transfer's destination/asset/amount, and — if so — whether
 * its memo matches the memo this transfer expects (#2369). Operation
 * records don't carry the memo themselves, so each candidate payment's
 * parent transaction is fetched to read it.
 */
async function checkPaymentReceived(
  server: StellarSdk.Horizon.Server,
  sep31Meta: any,
  expectedAmount: string,
): Promise<PaymentCheckResult> {
  try {
    const operations = await server
      .operations()
      .forAccount(
        sep31Meta.stellar_account_id || process.env.STELLAR_RECEIVING_ACCOUNT,
      )
      .includeFailed(false)
      .limit(10)
      .call();

    const candidatePayments: StellarPaymentRecord[] = [];
    for (const op of operations.records as any[]) {
      if (op.type !== "payment") continue;

      let memo: string | null = null;
      let memoType: string | null = null;
      try {
        const tx = await op.transaction();
        memo = tx.memo ?? null;
        memoType = tx.memo_type ?? null;
      } catch (txError) {
        logger.warn(
          { error: txError, operationId: op.id },
          "[sep31-monitor] Could not load parent transaction for memo check",
        );
      }

      candidatePayments.push({
        from: op.from,
        amount: op.amount,
        assetCode: op.asset_type === "native" ? "XLM" : op.asset_code,
        assetIssuer: op.asset_type === "native" ? undefined : op.asset_issuer,
        transactionHash: op.transaction_hash,
        memoType,
        memo,
      });
    }

    const match = matchPaymentByMemo(candidatePayments, {
      expectedAmount,
      expectedAssetCode: sep31Meta.asset_code,
      expectedAssetIssuer: sep31Meta.asset_issuer,
      expectedMemo: sep31Meta.memo,
      expectedMemoType: sep31Meta.memo_type || "text",
    });

    if (!match) {
      return { matched: false, memoValid: false, payment: null };
    }

    return { matched: true, memoValid: match.memoValid, payment: match.payment };
  } catch (error) {
    logger.error("[sep31-monitor] Error checking payment:", error);
    return { matched: false, memoValid: false, payment: null };
  }
}

/**
 * Sends the mismatched payment's amount back to its source account
 * on-chain, and records the refund on the transaction's metadata so the
 * monitor doesn't try to refund the same payment twice. Logs and gives up
 * (leaving the transaction in `error` for manual follow-up) rather than
 * throwing, consistent with how the rest of this job degrades — a refund
 * secret misconfiguration shouldn't crash the monitor loop.
 */
async function refundMismatchedPayment(
  transactionId: string,
  currentMetadata: any,
  payment: StellarPaymentRecord,
): Promise<void> {
  const transactionModel = new TransactionModel();

  try {
    const refundSecret = process.env.STELLAR_RECEIVING_ACCOUNT_SECRET;
    if (!refundSecret) {
      logger.error(
        `[sep31-monitor] Cannot refund transaction ${transactionId}: STELLAR_RECEIVING_ACCOUNT_SECRET not configured`,
      );
      return;
    }

    const server = getStellarServer();
    const keypair = StellarSdk.Keypair.fromSecret(refundSecret);
    const account = await server.loadAccount(keypair.publicKey());

    const asset = payment.assetIssuer
      ? new StellarSdk.Asset(payment.assetCode, payment.assetIssuer)
      : StellarSdk.Asset.native();

    const baseFee = await server
      .feeStats()
      .then((res) =>
        Number(res.fee_charged?.p90 || res.last_ledger_base_fee || 100),
      );

    const refundTx = new StellarSdk.TransactionBuilder(account, {
      fee: baseFee.toString(),
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: payment.from,
          asset,
          amount: payment.amount,
        }),
      )
      .addMemo(StellarSdk.Memo.text("SEP31 refund: invalid memo"))
      .setTimeout(30)
      .build();

    refundTx.sign(keypair);
    const response = await server.submitTransaction(refundTx);

    console.log(
      `[sep31-monitor] Refunded mismatched payment for transaction ${transactionId}, refund hash: ${response.hash}`,
    );

    const updatedMetadata = {
      ...currentMetadata,
      sep31: {
        ...currentMetadata.sep31,
        refunded: true,
        refund: {
          reason: "invalid_or_missing_memo",
          refundedPayment: {
            from: payment.from,
            amount: payment.amount,
            transactionHash: payment.transactionHash,
            memo: payment.memo,
          },
          refundTransactionHash: response.hash,
          refundedAt: new Date().toISOString(),
        },
      },
    };
    await transactionModel.updateMetadata(transactionId, updatedMetadata);
  } catch (error) {
    logger.error(
      `[sep31-monitor] Failed to refund mismatched payment for transaction ${transactionId}:`,
      error,
    );
  }
}

async function updateSep31Status(
  transactionId: string,
  newStatus: Sep31Status,
  currentMetadata: any,
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
      transactionStatus = TransactionStatus.Pending;
  }

  await transactionModel.updateStatus(transactionId, transactionStatus);
}
