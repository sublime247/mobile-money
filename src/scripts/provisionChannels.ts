import { printError } from "./momo-cli";
/**
 * Provision Channel Accounts Script (Optimized Batching)
 * Issue: #843
 */

import * as StellarSdk from "stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

import { getStellarServer, getNetworkPassphrase } from "../config/stellar";
import { ChannelAccountModel } from "../models/channelAccount";

function parseArgs(): { count: number; balance: string } {
  const args = process.argv.slice(2);
  let count = 10;
  let balance = "3";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--count" && args[i + 1]) {
      count = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === "--balance" && args[i + 1]) {
      balance = args[i + 1];
      i++;
    }
  }

  if (isNaN(count) || count < 1) {
    printError("--count must be a positive integer");
    process.exit(1);
  }

  if (isNaN(parseFloat(balance)) || parseFloat(balance) <= 0) {
    printError("--balance must be a positive number");
    process.exit(1);
  }

  return { count, balance };
}

async function main() {
  const { count, balance } = parseArgs();

  const issuerSecret = process.env.STELLAR_ISSUER_SECRET?.trim();
  if (!issuerSecret) {
    printError(
      "Error: STELLAR_ISSUER_SECRET environment variable is required.",
    );
    process.exit(1);
  }

  const funderKeypair = StellarSdk.Keypair.fromSecret(issuerSecret);
  const server = getStellarServer();
  const networkPassphrase = getNetworkPassphrase();
  const model = new ChannelAccountModel();

  console.log("   Channel Accounts Provisioner (Batched)");
  console.log(`  Network:   ${process.env.STELLAR_NETWORK || "testnet"}`);
  console.log(`  Funder:    ${funderKeypair.publicKey().substring(0, 12)}...`);
  console.log(`  Count:     ${count}`);
  console.log(`  Balance:   ${balance} XLM each`);

  const createdPairs: Array<{ publicKey: string; secretKey: string }> = [];
  const storedRows: Array<{ publicKey: string; id: string }> = [];

  // 1. Generate all keypairs locally first
  for (let i = 0; i < count; i++) {
    const kp = StellarSdk.Keypair.random();
    createdPairs.push({ publicKey: kp.publicKey(), secretKey: kp.secret() });
  }

  // Stellar limits transactions to 100 operations max. We will use chunks of 50 for safety.
  const CHUNK_SIZE = 50;
  let funderAccount = await server.loadAccount(funderKeypair.publicKey());

  for (let i = 0; i < createdPairs.length; i += CHUNK_SIZE) {
    const chunk = createdPairs.slice(i, i + CHUNK_SIZE);
    console.log(
      `Processing batch ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} accounts)...`,
    );

    try {
      const txBuilder = new StellarSdk.TransactionBuilder(funderAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase,
      });

      // Add all account creations in this chunk as operations in a single tx
      for (const pair of chunk) {
        txBuilder.addOperation(
          StellarSdk.Operation.createAccount({
            destination: pair.publicKey,
            startingBalance: balance,
          }),
        );
      }

      const tx = txBuilder.setTimeout(60).build();
      tx.sign(funderKeypair);

      const response = await server.submitTransaction(tx);
      console.log(`  ✓ Batch funded on-chain (ledger: ${response.ledger})`);

      // 2. Process database persistence for this batch
      for (const pair of chunk) {
        // Since the accounts were just created, their sequence numbers on-chain match
        // the ledger's starting sequence format. However, instead of hammering Horizon
        // with loadAccount calls for every single newly-created account, we can safely derive
        // the initial sequence boundary or perform a quick lookup if necessary.
        // To be completely safe and highly performing, we fetch it from the network chunk-by-chunk.
        const acctInfo = await server.loadAccount(pair.publicKey);
        const sequence = acctInfo.sequenceNumber();

        const row = await model.create(pair.publicKey, pair.secretKey, {
          balance,
          sequence,
          status: "idle",
        });

        storedRows.push({ publicKey: pair.publicKey, id: row.id });
      }
    } catch (error) {
      printError(
        `  ✗ Failed to process batch starting at index ${i}:`,
        error,
      );
      break;
    }
  }

  // Summary
  console.log("\n========================================");
  console.log(
    `  Provisioning Complete: ${storedRows.length}/${count} accounts`,
  );
  console.log("========================================");

  for (const acct of storedRows) {
    console.log(`  ${acct.publicKey} -> DB ID: ${acct.id}`);
  }

  if (storedRows.length > 0) {
    console.log(
      `\nChannel accounts are ready. The pool will pick them up on next initialization.`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  printError("Fatal error:", err);
  process.exit(1);
});
