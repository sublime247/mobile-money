import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";
import * as StellarSdk from "stellar-sdk";
import { getConfiguredPaymentAsset } from "../services/stellar/assetService";

/**
 * Fee Bump Job
 * Schedule: Every 30 seconds
 * Monitors pending Stellar transactions and bumps fees if stuck.
 */
export async function runFeeBumpJob(): Promise<void> {
  const transactionModel = new TransactionModel();
  const server = getStellarServer();

  try {
    // Find pending transactions with Stellar metadata submitted more than 30 seconds ago
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000).toISOString();

    const result = await pool.query(`
      SELECT id, metadata, stellar_address, amount
      FROM transactions
      WHERE status = 'pending'
        AND provider = 'stellar'
        AND metadata->'stellar'->>'submittedAt' IS NOT NULL
        AND metadata->'stellar'->>'submittedAt' < $1
    `, [thirtySecondsAgo]);

    console.log(`[fee-bump] Found ${result.rows.length} transactions to check for fee bumping`);

    for (const row of result.rows) {
      try {
        const metadata = row.metadata as any;
        const stellarMeta = metadata.stellar;
        const transactionHash = stellarMeta.transactionHash;

        // Check if transaction is still pending on the network
        const isConfirmed = await checkTransactionConfirmed(server, transactionHash);
        if (isConfirmed) {
          console.log(`[fee-bump] Transaction ${row.id} (${transactionHash}) is now confirmed`);
          // Update status to completed
          await transactionModel.updateStatus(row.id, TransactionStatus.Completed);
          continue;
        }

        // Transaction is still pending, attempt fee bump
        const feeBumpCount = stellarMeta.feeBumps?.length || 0;
        if (feeBumpCount >= 3) { // Max 3 fee bumps
          console.warn(`[fee-bump] Transaction ${row.id} has reached max fee bumps, marking as failed`);
          await transactionModel.updateStatus(row.id, TransactionStatus.Failed);
          continue;
        }

        await performFeeBump(row.id, row.stellar_address, row.amount, metadata, server);
        console.log(`[fee-bump] Performed fee bump for transaction ${row.id}`);

      } catch (error) {
        console.error(`[fee-bump] Error processing transaction ${row.id}:`, error);
      }
    }
  } catch (error) {
    console.error("[fee-bump] Job failed:", error);
  }
}

async function checkTransactionConfirmed(server: StellarSdk.Horizon.Server, hash: string): Promise<boolean> {
  try {
    await server.transactions().transaction(hash).call();
    return true; // Transaction exists, so it's confirmed
  } catch (error: any) {
    if (error.response?.status === 404) {
      return false; // Transaction not found, still pending
    }
    // Other errors might indicate network issues, assume still pending
    console.warn(`[fee-bump] Error checking transaction ${hash}:`, error.message);
    return false;
  }
}

async function performFeeBump(
  transactionId: string,
  destinationAddress: string,
  amount: string,
  metadata: any,
  server: StellarSdk.Horizon.Server
): Promise<void> {
  const transactionModel = new TransactionModel();
  const stellarMeta = metadata.stellar;

  try {
    // Load the issuer account (assuming it's the source for payments)
    const issuerSecret = process.env.STELLAR_ISSUER_SECRET;
    if (!issuerSecret) {
      throw new Error("STELLAR_ISSUER_SECRET not configured");
    }

    const keypair = StellarSdk.Keypair.fromSecret(issuerSecret);
    const account = await server.loadAccount(keypair.publicKey());

    const paymentAsset = getConfiguredPaymentAsset();

    // Calculate new fee (double the previous fee, starting from BASE_FEE)
    const previousFee = stellarMeta.feeBumps?.length > 0
      ? stellarMeta.feeBumps[stellarMeta.feeBumps.length - 1].fee
      : StellarSdk.BASE_FEE;
    const newFee = Math.min(previousFee * 2, 100000); // Max 1 XLM in stroops

    const transaction = new StellarSdk.TransactionBuilder(account, {
      fee: newFee.toString(),
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: destinationAddress,
          asset: paymentAsset,
          amount: amount,
        }),
      )
      .setTimeout(30)
      .build();

    transaction.sign(keypair);
    const response = await server.submitTransaction(transaction);

    console.log(`[fee-bump] Fee bumped transaction ${transactionId} with new hash ${response.hash}, fee: ${newFee}`);

    // Update metadata with new transaction details
    const updatedMetadata = {
      ...metadata,
      stellar: {
        ...stellarMeta,
        transactionHash: response.hash,
        submittedAt: new Date().toISOString(),
        feeBumps: [
          ...(stellarMeta.feeBumps || []),
          {
            previousHash: stellarMeta.transactionHash,
            newHash: response.hash,
            fee: newFee,
            bumpedAt: new Date().toISOString(),
          },
        ],
      },
    };

    await transactionModel.updateMetadata(transactionId, updatedMetadata);

  } catch (error) {
    console.error(`[fee-bump] Failed to fee bump transaction ${transactionId}:`, error);
    throw error;
  }
}