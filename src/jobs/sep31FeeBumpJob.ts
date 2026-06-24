import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { Sep31Status, mapToSep31Status, isValidTransition } from "../stellar/sep31";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";
import * as StellarSdk from "stellar-sdk";
import { getConfiguredPaymentAsset } from "../services/stellar/assetService";

/**
 * SEP-31 Fee Bump Job
 * Schedule: Every 30 seconds
 * Monitors SEP-31 transactions stuck in pending_stellar and bumps fees if needed.
 */
export async function runSep31FeeBumpJob(): Promise<void> {
  const transactionModel = new TransactionModel();
  const server = getStellarServer();

  try {
    // Find SEP-31 transactions in pending_stellar for > 60s
    const sixtySecondsAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const result = await pool.query(`
      SELECT id, metadata, stellar_address, amount, status
      FROM transactions
      WHERE status = 'pending'
        AND provider = 'stellar-sep31'
        AND metadata->'sep31'->>'status' = 'pending_stellar'
        AND metadata->'sep31'->>'submittedAt' IS NOT NULL
        AND metadata->'sep31'->>'submittedAt' < $1
    `, [sixtySecondsAgo]);

    console.log(`[sep31-fee-bump] Found ${result.rows.length} stuck SEP-31 transactions`);

    for (const row of result.rows) {
      try {
        const metadata = row.metadata as any;
        const sep31Meta = metadata.sep31;
        const transactionHash = sep31Meta.transactionHash;

        // Check if transaction is still pending on the network
        const isConfirmed = await checkTransactionConfirmed(server, transactionHash);
        if (isConfirmed) {
          console.log(`[sep31-fee-bump] Transaction ${row.id} (${transactionHash}) is now confirmed`);
          // Update status to pending_receiver
          await updateSep31Status(row.id, Sep31Status.PendingReceiver, metadata);
          continue;
        }

        // Transaction is still pending, attempt fee bump
        const feeBumpCount = sep31Meta.feeBumps?.length || 0;
        if (feeBumpCount >= 3) { // Max 3 fee bumps
          console.warn(`[sep31-fee-bump] Transaction ${row.id} reached max fee bumps, marking as error`);
          await updateSep31Status(row.id, Sep31Status.Error, metadata);
          continue;
        }

        await performSep31FeeBump(row.id, row.stellar_address, row.amount, metadata, server);
        console.log(`[sep31-fee-bump] Performed fee bump for SEP-31 transaction ${row.id}`);
      } catch (error) {
        console.error(`[sep31-fee-bump] Error processing SEP-31 transaction ${row.id}:`, error);
      }
    }
  } catch (error) {
    console.error("[sep31-fee-bump] Job failed:", error);
  }
}

async function checkTransactionConfirmed(server: StellarSdk.Horizon.Server, hash: string): Promise<boolean> {
  try {
    await server.transactions().transaction(hash).call();
    return true;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return false;
    }
    console.warn(`[sep31-fee-bump] Error checking transaction ${hash}:`, error.message);
    return false;
  }
}

async function performSep31FeeBump(
  transactionId: string,
  destinationAddress: string,
  amount: string,
  metadata: any,
  server: StellarSdk.Horizon.Server
): Promise<void> {
  const transactionModel = new TransactionModel();
  const sep31Meta = metadata.sep31;

  try {
    // Use dedicated fee-bump account
    const feeBumpSecret = process.env.STELLAR_FEE_BUMP_SECRET;
    if (!feeBumpSecret) {
      throw new Error("STELLAR_FEE_BUMP_SECRET not configured");
    }
    const keypair = StellarSdk.Keypair.fromSecret(feeBumpSecret);
    const account = await server.loadAccount(keypair.publicKey());
    const paymentAsset = getConfiguredPaymentAsset();

    // Fetch current network base fee and adjust dynamically
    const baseFee = await server.feeStats().then(res => Number(res.last_ledger_base_fee));
    const previousFee = sep31Meta.feeBumps?.length > 0
      ? sep31Meta.feeBumps[sep31Meta.feeBumps.length - 1].fee
      : baseFee;
    // Increase fee by a multiplier; use 2x if network fee increased, else 1.5x
    const multiplier = baseFee > previousFee ? 2 : 1.5;
    const newFee = Math.min(Math.ceil(previousFee * multiplier), 100000);

    // Rebuild original transaction (assume payment)
    const txBuilder = new StellarSdk.TransactionBuilder(account, {
      fee: newFee.toString(),
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: destinationAddress,
          asset: paymentAsset,
          amount: amount,
        })
      )
      .setTimeout(30)
      .build();

    txBuilder.sign(keypair);
    const response = await server.submitTransaction(txBuilder);

    console.log(`[sep31-fee-bump] Fee bumped SEP-31 transaction ${transactionId} with new hash ${response.hash}, fee: ${newFee}`);

    // Update metadata
    const updatedMetadata = {
      ...metadata,
      sep31: {
        ...sep31Meta,
        transactionHash: response.hash,
        submittedAt: new Date().toISOString(),
        feeBumps: [
          ...(sep31Meta.feeBumps || []),
          {
            previousHash: sep31Meta.transactionHash,
            newHash: response.hash,
            fee: newFee,
            bumpedAt: new Date().toISOString(),
          },
        ],
      },
    };
    await transactionModel.updateMetadata(transactionId, updatedMetadata);
  } catch (error) {
    console.error(`[sep31-fee-bump] Failed to fee bump SEP-31 transaction ${transactionId}:`, error);
    throw error;
  }
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
  // Update transaction status
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
