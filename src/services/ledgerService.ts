import { Pool, PoolClient } from "pg";
import { pool } from "../config/database";

/**
 * Double-Entry Ledger Service
 * Provides atomic, immutable financial transaction posting
 */

export interface LedgerEntry {
  account_code: string;
  debit_amount?: number;
  credit_amount?: number;
  description?: string;
  metadata?: Record<string, any>;
}

export interface PostedEntry {
  entry_id: string;
  account_code: string;
  debit: number;
  credit: number;
}

export interface AccountBalance {
  account_id: string;
  code: string;
  name: string;
  type: string;
  normal_balance: string;
  total_debits: number;
  total_credits: number;
  balance: number;
  last_entry_at: Date | null;
}

export interface TrialBalance {
  account_code: string;
  account_name: string;
  account_type: string;
  debit_balance: number;
  credit_balance: number;
}

export interface LedgerBalanceCheck {
  total_debits: number;
  total_credits: number;
  difference: number;
  is_balanced: boolean;
}

export class LedgerService {
  private pool: Pool;

  constructor(dbPool: Pool = pool) {
    this.pool = dbPool;
  }

  /**
   * Post a double-entry transaction atomically
   * Ensures debits = credits before committing
   */
  async postTransaction(
    referenceNumber: string,
    description: string,
    entries: LedgerEntry[],
    transactionId?: string,
    postedBy?: string,
  ): Promise<PostedEntry[]> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Validate entries
      if (!entries || entries.length < 2) {
        throw new Error("At least 2 entries required for double-entry");
      }

      // Calculate totals for client-side validation
      const totalDebits = entries.reduce(
        (sum, e) => sum + (e.debit_amount || 0),
        0,
      );
      const totalCredits = entries.reduce(
        (sum, e) => sum + (e.credit_amount || 0),
        0,
      );

      if (Math.abs(totalDebits - totalCredits) > 0.0000001) {
        throw new Error(
          `Transaction not balanced: debits=${totalDebits} credits=${totalCredits}`,
        );
      }

      // Call the database function to post atomically
      const result = await client.query(
        `SELECT * FROM post_transaction($1, $2, $3, $4, $5)`,
        [
          referenceNumber,
          description,
          transactionId || null,
          postedBy || null,
          JSON.stringify(entries),
        ],
      );

      await client.query("COMMIT");

      return result.rows.map((row) => ({
        entry_id: row.entry_id,
        account_code: row.account_code,
        debit: parseFloat(row.debit),
        credit: parseFloat(row.credit),
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Post a deposit transaction
   * Debit: Mobile Money Float (asset increases)
   * Credit: Customer Balances (liability increases)
   */
  async postDeposit(
    amount: number,
    fee: number,
    referenceNumber: string,
    transactionId: string,
    userId: string,
  ): Promise<PostedEntry[]> {
    const entries: LedgerEntry[] = [
      {
        account_code: "1100", // Mobile Money Float
        debit_amount: amount,
        description: "Customer deposit received",
      },
      {
        account_code: "2000", // Customer Balances
        credit_amount: amount - fee,
        description: "Customer balance credited",
      },
    ];

    // Add fee revenue if applicable
    if (fee > 0) {
      entries.push({
        account_code: "4100", // Deposit Fee Revenue
        credit_amount: fee,
        description: "Deposit fee earned",
      });
    }

    return this.postTransaction(
      referenceNumber,
      `Deposit: ${amount} (fee: ${fee})`,
      entries,
      transactionId,
      userId,
    );
  }

  /**
   * Post a withdrawal transaction
   * Debit: Customer Balances (liability decreases)
   * Credit: Mobile Money Float (asset decreases)
   */
  async postWithdrawal(
    amount: number,
    fee: number,
    referenceNumber: string,
    transactionId: string,
    userId: string,
  ): Promise<PostedEntry[]> {
    const entries: LedgerEntry[] = [
      {
        account_code: "2000", // Customer Balances
        debit_amount: amount + fee,
        description: "Customer balance debited",
      },
      {
        account_code: "1100", // Mobile Money Float
        credit_amount: amount,
        description: "Withdrawal paid out",
      },
    ];

    // Add fee revenue if applicable
    if (fee > 0) {
      entries.push({
        account_code: "4200", // Withdrawal Fee Revenue
        credit_amount: fee,
        description: "Withdrawal fee earned",
      });
    }

    return this.postTransaction(
      referenceNumber,
      `Withdrawal: ${amount} (fee: ${fee})`,
      entries,
      transactionId,
      userId,
    );
  }

  /**
   * Post a clawback transaction (reversal due to fraud)
   * Debit: Customer Balances (liability decreases)
   * Credit: Mobile Money Float (asset decreases)
   */
  async postClawback(
    amount: number,
    referenceNumber: string,
    transactionId: string,
    userId: string,
    reason: string,
  ): Promise<PostedEntry[]> {
    const entries: LedgerEntry[] = [
      {
        account_code: "2000", // Customer Balances
        debit_amount: amount,
        description: `Clawback: ${reason}`,
      },
      {
        account_code: "1100", // Mobile Money Float
        credit_amount: amount,
        description: `Clawback reversal: ${referenceNumber}`,
      },
    ];

    return this.postTransaction(
      referenceNumber,
      `Clawback: ${amount} - Reason: ${reason}`,
      entries,
      transactionId,
      userId,
    );
  }

  /**
   * Post provider fee expense
   * Debit: Provider Transaction Fees (expense increases)
   * Credit: Cash/Float (asset decreases)
   */
  async postProviderFee(
    amount: number,
    referenceNumber: string,
    transactionId: string,
  ): Promise<PostedEntry[]> {
    const entries: LedgerEntry[] = [
      {
        account_code: "5000", // Provider Transaction Fees
        debit_amount: amount,
        description: "Provider fee expense",
      },
      {
        account_code: "1100", // Mobile Money Float
        credit_amount: amount,
        description: "Provider fee paid",
      },
    ];

    return this.postTransaction(
      referenceNumber,
      `Provider fee: ${amount}`,
      entries,
      transactionId,
    );
  }

  /**
   * Get account balance as of a specific date
   */
  async getAccountBalance(
    accountCode: string,
    asOfDate?: Date,
  ): Promise<number> {
    const result = await this.pool.query(
      "SELECT get_account_balance($1, $2) as balance",
      [accountCode, asOfDate || new Date()],
    );
    return parseFloat(result.rows[0].balance);
  }

  /**
   * Get all account balances (from materialized view)
   */
  async getAllAccountBalances(): Promise<AccountBalance[]> {
    const result = await this.pool.query(
      "SELECT * FROM account_balances ORDER BY code",
    );
    return result.rows.map((row) => ({
      account_id: row.account_id,
      code: row.code,
      name: row.name,
      type: row.type,
      normal_balance: row.normal_balance,
      total_debits: parseFloat(row.total_debits),
      total_credits: parseFloat(row.total_credits),
      balance: parseFloat(row.balance),
      last_entry_at: row.last_entry_at,
    }));
  }

  /**
   * Refresh the account balances materialized view
   */
  async refreshAccountBalances(): Promise<void> {
    await this.pool.query("SELECT refresh_account_balances()");
  }

  /**
   * Get trial balance (all account balances at a point in time)
   */
  async getTrialBalance(asOfDate?: Date): Promise<TrialBalance[]> {
    const result = await this.pool.query(
      "SELECT * FROM get_trial_balance($1)",
      [asOfDate || new Date()],
    );
    return result.rows.map((row) => ({
      account_code: row.account_code,
      account_name: row.account_name,
      account_type: row.account_type,
      debit_balance: parseFloat(row.debit_balance),
      credit_balance: parseFloat(row.credit_balance),
    }));
  }

  /**
   * Check if the entire ledger is balanced
   */
  async checkLedgerBalance(): Promise<LedgerBalanceCheck> {
    const result = await this.pool.query(
      "SELECT * FROM check_ledger_balance()",
    );
    const row = result.rows[0];
    return {
      total_debits: parseFloat(row.total_debits),
      total_credits: parseFloat(row.total_credits),
      difference: parseFloat(row.difference),
      is_balanced: row.is_balanced,
    };
  }

  /**
   * Get ledger entries for a specific transaction
   */
  async getEntriesByTransaction(transactionId: string) {
    const result = await this.pool.query(
      `SELECT 
        le.id,
        le.entry_date,
        a.code as account_code,
        a.name as account_name,
        le.debit_amount,
        le.credit_amount,
        le.description,
        le.reference_number,
        le.created_at
      FROM ledger_entries le
      JOIN accounts a ON le.account_id = a.id
      WHERE le.transaction_id = $1
      ORDER BY le.created_at`,
      [transactionId],
    );
    return result.rows;
  }

  /**
   * Get ledger entries for a specific account
   */
  async getEntriesByAccount(
    accountCode: string,
    startDate?: Date,
    endDate?: Date,
    limit: number = 100,
  ) {
    const result = await this.pool.query(
      `SELECT 
        le.id,
        le.entry_date,
        a.code as account_code,
        a.name as account_name,
        le.debit_amount,
        le.credit_amount,
        le.description,
        le.reference_number,
        le.transaction_id,
        le.created_at
      FROM ledger_entries le
      JOIN accounts a ON le.account_id = a.id
      WHERE a.code = $1
        AND ($2::DATE IS NULL OR le.entry_date >= $2)
        AND ($3::DATE IS NULL OR le.entry_date <= $3)
      ORDER BY le.entry_date DESC, le.created_at DESC
      LIMIT $4`,
      [accountCode, startDate || null, endDate || null, limit],
    );
    return result.rows;
  }
}

// Export singleton instance
export const ledgerService = new LedgerService();
