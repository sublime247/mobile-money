import { Pool, QueryResult } from 'pg';
import { pool } from '../config/database';
import {
  decodeLedgerEntryCursor,
  encodeLedgerEntryCursor,
  LedgerEntryPage,
} from '../services/ledgerService';

/**
 * Ledger Model
 * Database access layer for double-entry ledger operations
 */

export interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normal_balance: 'debit' | 'credit';
  parent_id: string | null;
  is_active: boolean;
  description: string | null;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface LedgerEntryRecord {
  id: string;
  entry_date: Date;
  account_id: string;
  debit_amount: number;
  credit_amount: number;
  transaction_id: string | null;
  reference_number: string;
  description: string;
  posted_by: string | null;
  metadata: Record<string, any>;
  created_at: Date;
  settlement_date: Date;
}

const normalizeLedgerEntryLimit = (limit: number): number => {
  if (!Number.isFinite(limit)) {
    return 100;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 500);
};

export class LedgerModel {
  private pool: Pool;

  constructor(dbPool: Pool = pool) {
    this.pool = dbPool;
  }

  /**
   * Get account by code
   */
  async getAccountByCode(code: string): Promise<Account | null> {
    const result = await this.pool.query(
      'SELECT * FROM accounts WHERE code = $1 AND is_active = true',
      [code]
    );
    return result.rows[0] || null;
  }

  /**
   * Get account by ID
   */
  async getAccountById(id: string): Promise<Account | null> {
    const result = await this.pool.query(
      'SELECT * FROM accounts WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all active accounts
   */
  async getAllAccounts(): Promise<Account[]> {
    const result = await this.pool.query(
      'SELECT * FROM accounts WHERE is_active = true ORDER BY code'
    );
    return result.rows;
  }

  /**
   * Get accounts by type
   */
  async getAccountsByType(
    type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  ): Promise<Account[]> {
    const result = await this.pool.query(
      'SELECT * FROM accounts WHERE type = $1 AND is_active = true ORDER BY code',
      [type]
    );
    return result.rows;
  }

  /**
   * Create a new account
   */
  async createAccount(account: {
    code: string;
    name: string;
    type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
    normal_balance: 'debit' | 'credit';
    parent_id?: string;
    description?: string;
    metadata?: Record<string, any>;
  }): Promise<Account> {
    const result = await this.pool.query(
      `INSERT INTO accounts (code, name, type, normal_balance, parent_id, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        account.code,
        account.name,
        account.type,
        account.normal_balance,
        account.parent_id || null,
        account.description || null,
        account.metadata || {}
      ]
    );
    return result.rows[0];
  }

  /**
   * Deactivate an account (soft delete)
   */
  async deactivateAccount(code: string): Promise<void> {
    await this.pool.query(
      'UPDATE accounts SET is_active = false WHERE code = $1',
      [code]
    );
  }

  /**
   * Get ledger entries by transaction ID
   */
  async getEntriesByTransactionId(transactionId: string): Promise<LedgerEntryRecord[]> {
    const result = await this.pool.query(
      `SELECT le.*, a.code as account_code, a.name as account_name
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       WHERE le.transaction_id = $1
       ORDER BY le.created_at`,
      [transactionId]
    );
    return result.rows;
  }

  /**
   * Get ledger entries by account
   */
  async getEntriesByAccount(
    accountCode: string,
    startDate?: Date,
    endDate?: Date,
    limit: number = 100,
    offset: number = 0
  ): Promise<LedgerEntryRecord[]> {
    const result = await this.pool.query(
      `SELECT le.*, a.code as account_code, a.name as account_name
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       WHERE a.code = $1
         AND ($2::DATE IS NULL OR le.entry_date >= $2)
         AND ($3::DATE IS NULL OR le.entry_date <= $3)
       ORDER BY le.entry_date DESC, le.created_at DESC
       LIMIT $4 OFFSET $5`,
      [accountCode, startDate || null, endDate || null, limit, offset]
    );
    return result.rows;
  }

  /**
   * Get ledger entries by account using keyset pagination
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
    const limit = normalizeLedgerEntryLimit(options.limit ?? 100);
    const cursor = options.cursor ? decodeLedgerEntryCursor(options.cursor) : null;
    const result = await this.pool.query(
      `SELECT le.*, a.code as account_code, a.name as account_name
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
        limit + 1
      ]
    );
    const hasMore = result.rows.length > limit;
    const entries = hasMore ? result.rows.slice(0, limit) : result.rows;

    return {
      entries,
      nextCursor: hasMore ? encodeLedgerEntryCursor(entries[entries.length - 1]) : null,
      hasMore,
      limit,
    };
  }

  /**
   * Get ledger entries by reference number
   */
  async getEntriesByReferenceNumber(referenceNumber: string): Promise<LedgerEntryRecord[]> {
    const result = await this.pool.query(
      `SELECT le.*, a.code as account_code, a.name as account_name
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       WHERE le.reference_number = $1
       ORDER BY le.created_at`,
      [referenceNumber]
    );
    return result.rows;
  }

  /**
   * Get ledger entries by date range
   */
  async getEntriesByDateRange(
    startDate: Date,
    endDate: Date,
    limit: number = 1000,
    offset: number = 0
  ): Promise<LedgerEntryRecord[]> {
    const result = await this.pool.query(
      `SELECT le.*, a.code as account_code, a.name as account_name
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       WHERE le.entry_date BETWEEN $1 AND $2
       ORDER BY le.entry_date DESC, le.created_at DESC
       LIMIT $3 OFFSET $4`,
      [startDate, endDate, limit, offset]
    );
    return result.rows;
  }

  /**
   * Get ledger entries by date range using keyset pagination
   */
  async getEntriesByDateRangePage(
    startDate: Date,
    endDate: Date,
    options: {
      limit?: number;
      cursor?: string;
    } = {}
  ): Promise<LedgerEntryPage> {
    const limit = normalizeLedgerEntryLimit(options.limit ?? 100);
    const cursor = options.cursor ? decodeLedgerEntryCursor(options.cursor) : null;
    const result = await this.pool.query(
      `SELECT le.*, a.code as account_code, a.name as account_name
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       WHERE le.entry_date BETWEEN $1 AND $2
         AND (
           $3::DATE IS NULL
           OR (le.entry_date, le.created_at, le.id) < ($3::DATE, $4::TIMESTAMP, $5::UUID)
         )
       ORDER BY le.entry_date DESC, le.created_at DESC, le.id DESC
       LIMIT $6`,
      [
        startDate,
        endDate,
        cursor?.entryDate || null,
        cursor?.createdAt || null,
        cursor?.id || null,
        limit + 1
      ]
    );
    const hasMore = result.rows.length > limit;
    const entries = hasMore ? result.rows.slice(0, limit) : result.rows;

    return {
      entries,
      nextCursor: hasMore ? encodeLedgerEntryCursor(entries[entries.length - 1]) : null,
      hasMore,
      limit,
    };
  }

  /**
   * Get account balance from materialized view
   */
  async getAccountBalanceFromView(accountCode: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT balance FROM account_balances WHERE code = $1',
      [accountCode]
    );
    return result.rows[0]?.balance || 0;
  }

  /**
   * Get available account balance (settled funds)
   */
  async getAvailableAccountBalance(accountCode: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT get_available_balance($1) as balance',
      [accountCode]
    );
    return parseFloat(result.rows[0]?.balance || 0);
  }

  /**
   * Get pending account balance (unsettled funds)
   */
  async getPendingAccountBalance(accountCode: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT get_pending_balance($1) as balance',
      [accountCode]
    );
    return parseFloat(result.rows[0]?.balance || 0);
  }

  /**
   * Get all account balances from materialized view
   */
  async getAllAccountBalancesFromView(): Promise<any[]> {
    const result = await this.pool.query(
      'SELECT * FROM account_balances ORDER BY code'
    );
    return result.rows;
  }

  /**
   * Refresh account balances materialized view
   */
  async refreshAccountBalances(): Promise<void> {
    await this.pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY account_balances');
  }

  /**
   * Get ledger statistics
   */
  async getLedgerStatistics(startDate?: Date, endDate?: Date): Promise<{
    total_entries: number;
    total_debits: number;
    total_credits: number;
    unique_transactions: number;
    unique_accounts: number;
  }> {
    const result = await this.pool.query(
      `SELECT 
        COUNT(*) as total_entries,
        SUM(debit_amount) as total_debits,
        SUM(credit_amount) as total_credits,
        COUNT(DISTINCT transaction_id) as unique_transactions,
        COUNT(DISTINCT account_id) as unique_accounts
       FROM ledger_entries
       WHERE ($1::DATE IS NULL OR entry_date >= $1)
         AND ($2::DATE IS NULL OR entry_date <= $2)`,
      [startDate || null, endDate || null]
    );
    
    const row = result.rows[0];
    return {
      total_entries: parseInt(row.total_entries),
      total_debits: parseFloat(row.total_debits || 0),
      total_credits: parseFloat(row.total_credits || 0),
      unique_transactions: parseInt(row.unique_transactions),
      unique_accounts: parseInt(row.unique_accounts)
    };
  }

  /**
   * Search ledger entries
   */
  async searchEntries(
    searchTerm: string,
    limit: number = 50
  ): Promise<LedgerEntryRecord[]> {
    const result = await this.pool.query(
      `SELECT le.*, a.code as account_code, a.name as account_name
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       WHERE le.description ILIKE $1
          OR le.reference_number ILIKE $1
          OR a.name ILIKE $1
          OR a.code ILIKE $1
       ORDER BY le.created_at DESC
       LIMIT $2`,
      [`%${searchTerm}%`, limit]
    );
    return result.rows;
  }

  /**
   * Get entries with metadata filter
   */
  async getEntriesWithMetadata(
    metadataKey: string,
    metadataValue: any,
    limit: number = 100
  ): Promise<LedgerEntryRecord[]> {
    const result = await this.pool.query(
      `SELECT le.*, a.code as account_code, a.name as account_name
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       WHERE le.metadata->$1 = $2
       ORDER BY le.created_at DESC
       LIMIT $3`,
      [metadataKey, JSON.stringify(metadataValue), limit]
    );
    return result.rows;
  }

  /**
   * Count entries by account
   */
  async countEntriesByAccount(accountCode: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       WHERE a.code = $1`,
      [accountCode]
    );
    return parseInt(result.rows[0].count);
  }

  /**
   * Get daily entry volume
   */
  async getDailyEntryVolume(days: number = 30): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT 
        entry_date,
        COUNT(*) as entry_count,
        SUM(debit_amount) as total_debits,
        SUM(credit_amount) as total_credits
       FROM ledger_entries
       WHERE entry_date >= CURRENT_DATE - $1
       GROUP BY entry_date
       ORDER BY entry_date DESC`,
      [days]
    );
    return result.rows;
  }
}

// Export singleton instance
export const ledgerModel = new LedgerModel();
