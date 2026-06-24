import { Pool } from 'pg';
import { pool } from '../config/database';
import { UserModel } from '../models/users';

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
  settlement_date?: string; // Format: YYYY-MM-DD
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

export interface LedgerEntryRow {
  id: string;
  entry_date: Date | string;
  account_code: string;
  account_name: string;
  debit_amount: number | string;
  credit_amount: number | string;
  description: string;
  reference_number: string;
  transaction_id: string | null;
  created_at: Date | string;
}

export interface LedgerEntryCursor {
  entryDate: string;
  createdAt: string;
  id: string;
}

export interface LedgerEntryPage {
  entries: LedgerEntryRow[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

const DEFAULT_LEDGER_ENTRY_LIMIT = 100;
const MAX_LEDGER_ENTRY_LIMIT = 500;
const LEDGER_BALANCE_TOLERANCE = 0.0000001;

const validateLedgerEntries = (entries: LedgerEntry[]): void => {
  if (!entries || entries.length < 2) {
    throw new Error('At least 2 entries required for double-entry');
  }

  const { totalDebits, totalCredits } = entries.reduce(
    (totals, entry, index) => {
      const debitAmount = entry.debit_amount || 0;
      const creditAmount = entry.credit_amount || 0;
      const hasDebit = debitAmount > 0;
      const hasCredit = creditAmount > 0;

      if (hasDebit === hasCredit) {
        throw new Error(
          `Ledger entry ${index + 1} must have exactly one non-zero amount`
        );
      }

      totals.totalDebits += debitAmount;
      totals.totalCredits += creditAmount;
      return totals;
    },
    { totalDebits: 0, totalCredits: 0 }
  );

  if (Math.abs(totalDebits - totalCredits) > LEDGER_BALANCE_TOLERANCE) {
    throw new Error(
      `Transaction not balanced: debits=${totalDebits} credits=${totalCredits}`
    );
  }

  if (totalDebits <= LEDGER_BALANCE_TOLERANCE) {
    throw new Error('Transaction amounts cannot be zero');
  }
};

const normalizeLimit = (limit: number): number => {
  if (!Number.isFinite(limit)) {
    return DEFAULT_LEDGER_ENTRY_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LEDGER_ENTRY_LIMIT);
};

const toCursorDate = (value: Date | string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeLedgerEntryCursor = (
  entry: Pick<LedgerEntryRow, 'entry_date' | 'created_at' | 'id'>
): string => {
  const payload: LedgerEntryCursor = {
    entryDate: toCursorDate(entry.entry_date),
    createdAt: toCursorDate(entry.created_at),
    id: entry.id,
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
};

export const decodeLedgerEntryCursor = (cursor: string): LedgerEntryCursor => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

    if (
      !parsed ||
      typeof parsed.entryDate !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('Cursor is missing required ledger entry fields');
    }

    if (
      Number.isNaN(Date.parse(parsed.entryDate)) ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new Error('Cursor contains invalid ledger entry values');
    }

    return parsed;
  } catch (error) {
    throw new Error('Invalid ledger entry cursor');
  }
};

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
    postedBy?: string
  ): Promise<PostedEntry[]> {
    validateLedgerEntries(entries);

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Call the database function to post atomically
      const result = await client.query(
        `SELECT * FROM post_transaction($1, $2, $3, $4, $5)`,
        [
          referenceNumber,
          description,
          transactionId || null,
          postedBy || null,
          JSON.stringify(entries)
        ]
      );

      await client.query('COMMIT');

      return result.rows.map(row => ({
        entry_id: row.entry_id,
        account_code: row.account_code,
        debit: parseFloat(row.debit),
        credit: parseFloat(row.credit)
      }));
    } catch (error) {
      await client.query('ROLLBACK');
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
    userId: string
  ): Promise<PostedEntry[]> {
    // Determine settlement delay from user
    const userModel = new UserModel();
    const user = await userModel.findById(userId);
    const delayDays = user?.settlementDelayDays || 0;
    
    // Calculate settlement date
    const settlementDate = new Date();
    settlementDate.setDate(settlementDate.getDate() + delayDays);
    const settlementDateStr = settlementDate.toISOString().split('T')[0];

    const entries: LedgerEntry[] = [
      {
        account_code: '1100', // Mobile Money Float
        debit_amount: amount,
        description: 'Customer deposit received'
      },
      {
        account_code: '2000', // Customer Balances
        credit_amount: amount - fee,
        description: 'Customer balance credited',
        settlement_date: settlementDateStr
      }
    ];

    // Add fee revenue if applicable
    if (fee > 0) {
      entries.push({
        account_code: '4100', // Deposit Fee Revenue
        credit_amount: fee,
        description: 'Deposit fee earned'
      });
    }

    return this.postTransaction(
      referenceNumber,
      `Deposit: ${amount} (fee: ${fee})`,
      entries,
      transactionId,
      userId
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
    userId: string
  ): Promise<PostedEntry[]> {
    const entries: LedgerEntry[] = [
      {
        account_code: '2000', // Customer Balances
        debit_amount: amount + fee,
        description: 'Customer balance debited'
      },
      {
        account_code: '1100', // Mobile Money Float
        credit_amount: amount,
        description: 'Withdrawal paid out'
      }
    ];

    // Add fee revenue if applicable
    if (fee > 0) {
      entries.push({
        account_code: '4200', // Withdrawal Fee Revenue
        credit_amount: fee,
        description: 'Withdrawal fee earned'
      });
    }

    return this.postTransaction(
      referenceNumber,
      `Withdrawal: ${amount} (fee: ${fee})`,
      entries,
      transactionId,
      userId
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
    reason: string
  ): Promise<PostedEntry[]> {
    const entries: LedgerEntry[] = [
      {
        account_code: '2000', // Customer Balances
        debit_amount: amount,
        description: `Clawback: ${reason}`
      },
      {
        account_code: '1100', // Mobile Money Float
        credit_amount: amount,
        description: `Clawback reversal: ${referenceNumber}`
      }
    ];

    return this.postTransaction(
      referenceNumber,
      `Clawback: ${amount} - Reason: ${reason}`,
      entries,
      transactionId,
      userId
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
    transactionId: string
  ): Promise<PostedEntry[]> {
    const entries: LedgerEntry[] = [
      {
        account_code: '5000', // Provider Transaction Fees
        debit_amount: amount,
        description: 'Provider fee expense'
      },
      {
        account_code: '1100', // Mobile Money Float
        credit_amount: amount,
        description: 'Provider fee paid'
      }
    ];

    return this.postTransaction(
      referenceNumber,
      `Provider fee: ${amount}`,
      entries,
      transactionId
    );
  }

  /**
   * Get account balance as of a specific date
   */
  async getAccountBalance(accountCode: string, asOfDate?: Date): Promise<number> {
    const result = await this.pool.query(
      'SELECT get_account_balance($1, $2) as balance',
      [accountCode, asOfDate || new Date()]
    );
    return parseFloat(result.rows[0].balance);
  }

  /**
   * Get all account balances (from materialized view)
   */
  async getAllAccountBalances(): Promise<AccountBalance[]> {
    const result = await this.pool.query(
      'SELECT * FROM account_balances ORDER BY code'
    );
    return result.rows.map(row => ({
      account_id: row.account_id,
      code: row.code,
      name: row.name,
      type: row.type,
      normal_balance: row.normal_balance,
      total_debits: parseFloat(row.total_debits),
      total_credits: parseFloat(row.total_credits),
      balance: parseFloat(row.balance),
      last_entry_at: row.last_entry_at
    }));
  }

  /**
   * Refresh the account balances materialized view
   */
  async refreshAccountBalances(): Promise<void> {
    await this.pool.query('SELECT refresh_account_balances()');
  }

  /**
   * Get trial balance (all account balances at a point in time)
   */
  async getTrialBalance(asOfDate?: Date): Promise<TrialBalance[]> {
    const result = await this.pool.query(
      'SELECT * FROM get_trial_balance($1)',
      [asOfDate || new Date()]
    );
    return result.rows.map(row => ({
      account_code: row.account_code,
      account_name: row.account_name,
      account_type: row.account_type,
      debit_balance: parseFloat(row.debit_balance),
      credit_balance: parseFloat(row.credit_balance)
    }));
  }

  /**
   * Check if the entire ledger is balanced
   */
  async checkLedgerBalance(): Promise<LedgerBalanceCheck> {
    const result = await this.pool.query('SELECT * FROM check_ledger_balance()');
    const row = result.rows[0];
    return {
      total_debits: parseFloat(row.total_debits),
      total_credits: parseFloat(row.total_credits),
      difference: parseFloat(row.difference),
      is_balanced: row.is_balanced
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
      [transactionId]
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
    limit: number = 100
  ): Promise<LedgerEntryRow[]> {
    const page = await this.getEntriesByAccountPage(accountCode, {
      startDate,
      endDate,
      limit,
    });

    return page.entries;
  }

  /**
   * Get a keyset-paginated page of ledger entries for a specific account
   */
  async getEntriesByAccountPage(
    accountCode: string,
    options: {
      startDate?: Date;
      endDate?: Date;
      limit?: number;
      cursor?: string;
    } = {}
  ): Promise<LedgerEntryPage> {
    const pageLimit = normalizeLimit(options.limit ?? DEFAULT_LEDGER_ENTRY_LIMIT);
    const cursor = options.cursor ? decodeLedgerEntryCursor(options.cursor) : null;
    const queryLimit = pageLimit + 1;

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
        AND (
          $4::DATE IS NULL
          OR (le.entry_date, le.created_at, le.id) < ($4::DATE, $5::TIMESTAMP, $6::UUID)
        )
      ORDER BY le.entry_date DESC, le.created_at DESC, le.id DESC
      LIMIT $7`,
      [
        accountCode,
        options.startDate || null,
        options.endDate || null,
        cursor?.entryDate || null,
        cursor?.createdAt || null,
        cursor?.id || null,
        queryLimit
      ]
    );

    const rows = result.rows as LedgerEntryRow[];
    const hasMore = rows.length > pageLimit;
    const entries = hasMore ? rows.slice(0, pageLimit) : rows;

    return {
      entries,
      nextCursor: hasMore ? encodeLedgerEntryCursor(entries[entries.length - 1]) : null,
      hasMore,
      limit: pageLimit,
    };
  }
}

// Export singleton instance
export const ledgerService = new LedgerService();
