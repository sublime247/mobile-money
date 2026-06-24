#!/usr/bin/env tsx
import { printError } from "./momo-cli";
/**
 * Ledger Reconciliation Script
 * 
 * Performs comprehensive reconciliation checks on the double-entry ledger:
 * 1. Verifies all debits equal all credits (fundamental accounting equation)
 * 2. Generates trial balance report
 * 3. Checks for orphaned transactions
 * 4. Validates account balances
 * 5. Identifies any data integrity issues
 * 
 * Usage:
 *   npm run reconcile:ledger
 *   tsx src/scripts/reconcile-ledger.ts
 *   tsx src/scripts/reconcile-ledger.ts --date=2026-04-01
 */

import { ledgerService } from '../services/ledgerService';
import { pool } from '../config/database';

interface ReconciliationReport {
  timestamp: Date;
  asOfDate: Date;
  ledgerBalanced: boolean;
  totalDebits: number;
  totalCredits: number;
  difference: number;
  trialBalance: any[];
  issues: string[];
  warnings: string[];
  summary: string;
}

async function reconcileLedger(asOfDate?: Date): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    timestamp: new Date(),
    asOfDate: asOfDate || new Date(),
    ledgerBalanced: false,
    totalDebits: 0,
    totalCredits: 0,
    difference: 0,
    trialBalance: [],
    issues: [],
    warnings: []
  } as any;

  console.log('🔍 Starting Ledger Reconciliation...\n');
  console.log(`📅 As of Date: ${report.asOfDate.toISOString().split('T')[0]}\n`);

  try {
    // Step 1: Check overall ledger balance
    console.log('1️⃣  Checking ledger balance...');
    const balanceCheck = await ledgerService.checkLedgerBalance();
    report.ledgerBalanced = balanceCheck.is_balanced;
    report.totalDebits = balanceCheck.total_debits;
    report.totalCredits = balanceCheck.total_credits;
    report.difference = balanceCheck.difference;

    if (balanceCheck.is_balanced) {
      console.log('   ✅ Ledger is balanced');
      console.log(`   📊 Total Debits:  ${balanceCheck.total_debits.toFixed(7)}`);
      console.log(`   📊 Total Credits: ${balanceCheck.total_credits.toFixed(7)}`);
    } else {
      console.log('   ❌ LEDGER IS NOT BALANCED!');
      console.log(`   📊 Total Debits:  ${balanceCheck.total_debits.toFixed(7)}`);
      console.log(`   📊 Total Credits: ${balanceCheck.total_credits.toFixed(7)}`);
      console.log(`   ⚠️  Difference:    ${balanceCheck.difference.toFixed(7)}`);
      report.issues.push(
        `Ledger not balanced: difference of ${balanceCheck.difference.toFixed(7)}`
      );
    }
    console.log('');

    // Step 2: Generate trial balance
    console.log('2️⃣  Generating trial balance...');
    const trialBalance = await ledgerService.getTrialBalance(report.asOfDate);
    report.trialBalance = trialBalance;

    let trialBalanceDebits = 0;
    let trialBalanceCredits = 0;

    console.log('   Account Code | Account Name                    | Type      | Debit        | Credit');
    console.log('   ' + '-'.repeat(95));

    for (const account of trialBalance) {
      trialBalanceDebits += account.debit_balance;
      trialBalanceCredits += account.credit_balance;

      const debitStr = account.debit_balance > 0 
        ? account.debit_balance.toFixed(2).padStart(12) 
        : ''.padStart(12);
      const creditStr = account.credit_balance > 0 
        ? account.credit_balance.toFixed(2).padStart(12) 
        : ''.padStart(12);

      console.log(
        `   ${account.account_code.padEnd(12)} | ` +
        `${account.account_name.padEnd(31)} | ` +
        `${account.account_type.padEnd(9)} | ` +
        `${debitStr} | ${creditStr}`
      );
    }

    console.log('   ' + '-'.repeat(95));
    console.log(
      `   ${'TOTALS'.padEnd(56)} | ` +
      `${trialBalanceDebits.toFixed(2).padStart(12)} | ` +
      `${trialBalanceCredits.toFixed(2).padStart(12)}`
    );

    if (Math.abs(trialBalanceDebits - trialBalanceCredits) < 0.01) {
      console.log('   ✅ Trial balance is balanced');
    } else {
      console.log('   ❌ Trial balance is NOT balanced');
      report.issues.push(
        `Trial balance not balanced: debits=${trialBalanceDebits} credits=${trialBalanceCredits}`
      );
    }
    console.log('');

    // Step 3: Check for transactions without ledger entries
    console.log('3️⃣  Checking for orphaned transactions...');
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
      console.log(`   ⚠️  Found ${orphanedCount} completed transactions without ledger entries`);
      report.warnings.push(
        `${orphanedCount} completed transactions have no ledger entries`
      );
    } else {
      console.log('   ✅ No orphaned transactions found');
    }
    console.log('');

    // Step 4: Check for unbalanced transaction groups
    console.log('4️⃣  Checking individual transaction balance...');
    const unbalancedResult = await pool.query(`
      SELECT 
        reference_number,
        SUM(debit_amount) as total_debits,
        SUM(credit_amount) as total_credits,
        SUM(debit_amount) - SUM(credit_amount) as difference
      FROM ledger_entries
      GROUP BY reference_number
      HAVING ABS(SUM(debit_amount) - SUM(credit_amount)) > 0.0000001
    `);

    if (unbalancedResult.rows.length > 0) {
      console.log(`   ❌ Found ${unbalancedResult.rows.length} unbalanced transactions:`);
      for (const row of unbalancedResult.rows.slice(0, 10)) {
        console.log(
          `      ${row.reference_number}: ` +
          `debits=${row.total_debits} credits=${row.total_credits} ` +
          `diff=${row.difference}`
        );
        report.issues.push(
          `Unbalanced transaction ${row.reference_number}: difference=${row.difference}`
        );
      }
      if (unbalancedResult.rows.length > 10) {
        console.log(`      ... and ${unbalancedResult.rows.length - 10} more`);
      }
    } else {
      console.log('   ✅ All transactions are balanced');
    }
    console.log('');

    // Step 5: Validate account types
    console.log('5️⃣  Validating account balances by type...');
    const accountBalances = await ledgerService.getAllAccountBalances();
    
    const assetTotal = accountBalances
      .filter(a => a.type === 'asset')
      .reduce((sum, a) => sum + a.balance, 0);
    
    const liabilityTotal = accountBalances
      .filter(a => a.type === 'liability')
      .reduce((sum, a) => sum + a.balance, 0);
    
    const equityTotal = accountBalances
      .filter(a => a.type === 'equity')
      .reduce((sum, a) => sum + a.balance, 0);
    
    const revenueTotal = accountBalances
      .filter(a => a.type === 'revenue')
      .reduce((sum, a) => sum + a.balance, 0);
    
    const expenseTotal = accountBalances
      .filter(a => a.type === 'expense')
      .reduce((sum, a) => sum + a.balance, 0);

    console.log(`   Assets:      ${assetTotal.toFixed(2)}`);
    console.log(`   Liabilities: ${liabilityTotal.toFixed(2)}`);
    console.log(`   Equity:      ${equityTotal.toFixed(2)}`);
    console.log(`   Revenue:     ${revenueTotal.toFixed(2)}`);
    console.log(`   Expenses:    ${expenseTotal.toFixed(2)}`);

    // Accounting equation: Assets = Liabilities + Equity + (Revenue - Expenses)
    const leftSide = assetTotal;
    const rightSide = liabilityTotal + equityTotal + (revenueTotal - expenseTotal);
    const equationDiff = Math.abs(leftSide - rightSide);

    console.log('');
    console.log('   Accounting Equation Check:');
    console.log(`   Assets = Liabilities + Equity + (Revenue - Expenses)`);
    console.log(`   ${leftSide.toFixed(2)} = ${rightSide.toFixed(2)}`);

    if (equationDiff < 0.01) {
      console.log('   ✅ Accounting equation balanced');
    } else {
      console.log(`   ⚠️  Accounting equation difference: ${equationDiff.toFixed(2)}`);
      report.warnings.push(
        `Accounting equation difference: ${equationDiff.toFixed(2)}`
      );
    }
    console.log('');

    // Generate summary
    if (report.issues.length === 0 && report.warnings.length === 0) {
      report.summary = '✅ All reconciliation checks passed. Ledger is audit-proof.';
    } else if (report.issues.length === 0) {
      report.summary = `⚠️  Reconciliation completed with ${report.warnings.length} warning(s).`;
    } else {
      report.summary = `❌ Reconciliation found ${report.issues.length} issue(s) and ${report.warnings.length} warning(s).`;
    }

  } catch (error) {
    printError('❌ Reconciliation failed:', error);
    report.issues.push(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    report.summary = '❌ Reconciliation failed due to error';
  }

  return report;
}

async function main() {
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);
    let asOfDate: Date | undefined;

    for (const arg of args) {
      if (arg.startsWith('--date=')) {
        const dateStr = arg.split('=')[1];
        asOfDate = new Date(dateStr);
        if (isNaN(asOfDate.getTime())) {
          printError('❌ Invalid date format. Use YYYY-MM-DD');
          process.exit(1);
        }
      }
    }

    const report = await reconcileLedger(asOfDate);

    // Print summary
    console.log('═'.repeat(100));
    console.log('📋 RECONCILIATION SUMMARY');
    console.log('═'.repeat(100));
    console.log(report.summary);
    console.log('');

    if (report.issues.length > 0) {
      console.log('❌ ISSUES:');
      report.issues.forEach((issue, i) => {
        console.log(`   ${i + 1}. ${issue}`);
      });
      console.log('');
    }

    if (report.warnings.length > 0) {
      console.log('⚠️  WARNINGS:');
      report.warnings.forEach((warning, i) => {
        console.log(`   ${i + 1}. ${warning}`);
      });
      console.log('');
    }

    console.log('═'.repeat(100));

    // Exit with appropriate code
    if (report.issues.length > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (error) {
    printError('Fatal error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { reconcileLedger };
export type { ReconciliationReport };
