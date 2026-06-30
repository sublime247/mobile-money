/**
 * Double-Entry Ledger Integration Example
 *
 * This example demonstrates how to integrate the double-entry ledger
 * with existing transaction processing flows.
 */

import { ledgerService } from "../src/services/ledgerService";
import { pool } from "../src/config/database";

/**
 * Example 1: Integrating ledger with deposit transaction
 */
async function processDepositWithLedger(
  userId: string,
  amount: number,
  phoneNumber: string,
  provider: string,
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Create the transaction record
    const txResult = await client.query(
      `INSERT INTO transactions (
        reference_number, type, amount, phone_number, 
        provider, stellar_address, status, user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        `DEP-${Date.now()}`,
        "deposit",
        amount,
        phoneNumber,
        provider,
        "STELLAR_ADDRESS_HERE",
        "pending",
        userId,
      ],
    );

    const transaction = txResult.rows[0];

    // 2. Process with mobile money provider
    // ... provider API call here ...

    // 3. Update transaction status
    await client.query("UPDATE transactions SET status = $1 WHERE id = $2", [
      "completed",
      transaction.id,
    ]);

    // 4. Post to double-entry ledger
    const fee = amount * 0.02; // 2% fee
    await ledgerService.postDeposit(
      amount,
      fee,
      transaction.reference_number,
      transaction.id,
      userId,
    );

    await client.query("COMMIT");

    console.log("✅ Deposit processed and posted to ledger");
    return transaction;
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Deposit failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Example 2: Integrating ledger with withdrawal transaction
 */
async function processWithdrawalWithLedger(
  userId: string,
  amount: number,
  phoneNumber: string,
  provider: string,
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Verify customer has sufficient balance
    const customerBalance = await ledgerService.getAccountBalance("2000");
    if (customerBalance < amount) {
      throw new Error("Insufficient balance");
    }

    // 2. Create the transaction record
    const txResult = await client.query(
      `INSERT INTO transactions (
        reference_number, type, amount, phone_number, 
        provider, stellar_address, status, user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        `WD-${Date.now()}`,
        "withdraw",
        amount,
        phoneNumber,
        provider,
        "STELLAR_ADDRESS_HERE",
        "pending",
        userId,
      ],
    );

    const transaction = txResult.rows[0];

    // 3. Process with mobile money provider
    // ... provider API call here ...

    // 4. Update transaction status
    await client.query("UPDATE transactions SET status = $1 WHERE id = $2", [
      "completed",
      transaction.id,
    ]);

    // 5. Post to double-entry ledger
    const fee = 5; // Fixed $5 fee
    await ledgerService.postWithdrawal(
      amount,
      fee,
      transaction.reference_number,
      transaction.id,
      userId,
    );

    await client.query("COMMIT");

    console.log("✅ Withdrawal processed and posted to ledger");
    return transaction;
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Withdrawal failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Example 3: Complex transaction with multiple ledger entries
 */
async function processExchangeTransaction(
  userId: string,
  fromAmount: number,
  toAmount: number,
  exchangeRate: number,
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const txResult = await client.query(
      `INSERT INTO transactions (
        reference_number, type, amount, phone_number, 
        provider, stellar_address, status, user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        `EXC-${Date.now()}`,
        "exchange",
        fromAmount,
        "+1234567890",
        "internal",
        "STELLAR_ADDRESS_HERE",
        "completed",
        userId,
      ],
    );

    const transaction = txResult.rows[0];

    // Calculate exchange spread revenue
    const expectedAmount = fromAmount * exchangeRate;
    const spreadRevenue = expectedAmount - toAmount;

    // Post complex multi-entry transaction
    await ledgerService.postTransaction(
      transaction.reference_number,
      `Currency exchange: ${fromAmount} to ${toAmount}`,
      [
        {
          account_code: "1200", // Stellar Asset Holdings (from currency)
          credit_amount: fromAmount,
          description: "Exchange from currency",
        },
        {
          account_code: "1200", // Stellar Asset Holdings (to currency)
          debit_amount: toAmount,
          description: "Exchange to currency",
        },
        {
          account_code: "4300", // Exchange Rate Revenue
          credit_amount: spreadRevenue,
          description: "Exchange spread revenue",
        },
      ],
      transaction.id,
      userId,
    );

    await client.query("COMMIT");

    console.log("✅ Exchange processed and posted to ledger");
    return transaction;
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Exchange failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Example 4: Scheduled job to reconcile ledger daily
 */
async function dailyReconciliationJob() {
  console.log("🔍 Starting daily ledger reconciliation...");

  try {
    // 1. Check ledger balance
    const balanceCheck = await ledgerService.checkLedgerBalance();

    if (!balanceCheck.is_balanced) {
      console.error("❌ CRITICAL: Ledger is not balanced!");
      // Send alert to operations team
      // await alertService.sendCriticalAlert('Ledger imbalance detected');
      return;
    }

    // 2. Refresh materialized views
    await ledgerService.refreshAccountBalances();

    // 3. Get trial balance
    const trialBalance = await ledgerService.getTrialBalance();

    // 4. Check for orphaned transactions
    const orphanedResult = await pool.query(`
      SELECT COUNT(*) as count
      FROM transactions t
      WHERE t.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries le WHERE le.transaction_id = t.id
        )
    `);

    const orphanedCount = parseInt(orphanedResult.rows[0].count);

    if (orphanedCount > 0) {
      console.warn(`⚠️  Found ${orphanedCount} orphaned transactions`);
      // Send warning to operations team
    }

    // 5. Generate daily report
    const report = {
      date: new Date().toISOString().split("T")[0],
      ledgerBalanced: balanceCheck.is_balanced,
      totalDebits: balanceCheck.total_debits,
      totalCredits: balanceCheck.total_credits,
      orphanedTransactions: orphanedCount,
      trialBalance: trialBalance,
    };

    console.log("✅ Daily reconciliation completed");
    console.log(JSON.stringify(report, null, 2));

    return report;
  } catch (error) {
    console.error("❌ Daily reconciliation failed:", error);
    throw error;
  }
}

/**
 * Example 5: Querying ledger for reporting
 */
async function generateFinancialReport(startDate: Date, endDate: Date) {
  console.log("📊 Generating financial report...");

  try {
    // Get trial balance
    const trialBalance = await ledgerService.getTrialBalance(endDate);

    // Calculate key metrics
    const assets = trialBalance
      .filter((a) => a.account_type === "asset")
      .reduce((sum, a) => sum + a.debit_balance, 0);

    const liabilities = trialBalance
      .filter((a) => a.account_type === "liability")
      .reduce((sum, a) => sum + a.credit_balance, 0);

    const revenue = trialBalance
      .filter((a) => a.account_type === "revenue")
      .reduce((sum, a) => sum + a.credit_balance, 0);

    const expenses = trialBalance
      .filter((a) => a.account_type === "expense")
      .reduce((sum, a) => sum + a.debit_balance, 0);

    const netIncome = revenue - expenses;

    // Get transaction volume
    const volumeResult = await pool.query(
      `SELECT 
        COUNT(*) as transaction_count,
        SUM(debit_amount) as total_volume
      FROM ledger_entries
      WHERE entry_date BETWEEN $1 AND $2`,
      [startDate, endDate],
    );

    const report = {
      period: {
        start: startDate.toISOString().split("T")[0],
        end: endDate.toISOString().split("T")[0],
      },
      balanceSheet: {
        assets,
        liabilities,
        equity: assets - liabilities,
      },
      incomeStatement: {
        revenue,
        expenses,
        netIncome,
      },
      operations: {
        transactionCount: parseInt(volumeResult.rows[0].transaction_count),
        totalVolume: parseFloat(volumeResult.rows[0].total_volume),
      },
    };

    console.log("✅ Financial report generated");
    console.log(JSON.stringify(report, null, 2));

    return report;
  } catch (error) {
    console.error("❌ Report generation failed:", error);
    throw error;
  }
}

/**
 * Example 6: Audit trail query
 */
async function getTransactionAuditTrail(transactionId: string) {
  console.log(`🔍 Getting audit trail for transaction ${transactionId}...`);

  try {
    // Get transaction details
    const txResult = await pool.query(
      "SELECT * FROM transactions WHERE id = $1",
      [transactionId],
    );

    if (txResult.rows.length === 0) {
      throw new Error("Transaction not found");
    }

    const transaction = txResult.rows[0];

    // Get all ledger entries for this transaction
    const entries = await ledgerService.getEntriesByTransaction(transactionId);

    const auditTrail = {
      transaction: {
        id: transaction.id,
        reference_number: transaction.reference_number,
        type: transaction.type,
        amount: transaction.amount,
        status: transaction.status,
        created_at: transaction.created_at,
      },
      ledgerEntries: entries.map((entry) => ({
        account: `${entry.account_code} - ${entry.account_name}`,
        debit: entry.debit_amount,
        credit: entry.credit_amount,
        description: entry.description,
        posted_at: entry.created_at,
      })),
      verification: {
        totalDebits: entries.reduce(
          (sum, e) => sum + parseFloat(e.debit_amount),
          0,
        ),
        totalCredits: entries.reduce(
          (sum, e) => sum + parseFloat(e.credit_amount),
          0,
        ),
        isBalanced: true,
      },
    };

    console.log("✅ Audit trail retrieved");
    console.log(JSON.stringify(auditTrail, null, 2));

    return auditTrail;
  } catch (error) {
    console.error("❌ Audit trail retrieval failed:", error);
    throw error;
  }
}

// Export examples
export {
  processDepositWithLedger,
  processWithdrawalWithLedger,
  processExchangeTransaction,
  dailyReconciliationJob,
  generateFinancialReport,
  getTransactionAuditTrail,
};

// Example usage (uncomment to run)
/*
async function main() {
  const userId = 'user-uuid-here';
  
  // Process a deposit
  await processDepositWithLedger(userId, 100, '+1234567890', 'orange');
  
  // Process a withdrawal
  await processWithdrawalWithLedger(userId, 50, '+1234567890', 'orange');
  
  // Run daily reconciliation
  await dailyReconciliationJob();
  
  // Generate financial report
  const startDate = new Date('2026-04-01');
  const endDate = new Date('2026-04-30');
  await generateFinancialReport(startDate, endDate);
  
  await pool.end();
}

main().catch(console.error);
*/
