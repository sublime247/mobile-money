import { Pool, PoolClient } from "pg";
import { pool } from "../config/database";
import { SupportedCurrency, currencyService, BASE_CURRENCY } from "./currency";
import { UserModel } from "../models/users";
import { notifySlackAlert } from "./loggers";
import { createPagerDutyService } from "./pagerDutyService";
import {
  UnbalancedLedgerException,
  assertLedgerBalanced,
  recordUnbalancedAttempt,
} from "./ledgerInvariant";

export { UnbalancedLedgerException } from "./ledgerInvariant";

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

const validateLedgerEntries = (
  entries: LedgerEntry[],
  referenceNumber?: string,
): void => {
  if (!entries || entries.length < 2) {
    throw new Error("At least 2 entries required for double-entry");
  }

  entries.forEach((entry, index) => {
    const hasDebit = (entry.debit_amount || 0) > 0;
    const hasCredit = (entry.credit_amount || 0) > 0;

    if (hasDebit === hasCredit) {
      throw new Error(
        `Ledger entry ${index + 1} must have exactly one non-zero amount`,
      );
    }
  });

  // Exact sum(debits) == sum(credits) to 7 decimal places (no float tolerance).
  const { totalDebits } = assertLedgerBalanced(entries, referenceNumber);

  if (Number(totalDebits) <= 0) {
    throw new Error("Transaction amounts cannot be zero");
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
  entry: Pick<LedgerEntryRow, "entry_date" | "created_at" | "id">,
): string => {
  const payload: LedgerEntryCursor = {
    entryDate: toCursorDate(entry.entry_date),
    createdAt: toCursorDate(entry.created_at),
    id: entry.id,
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
};

export const decodeLedgerEntryCursor = (cursor: string): LedgerEntryCursor => {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );

    if (
      !parsed ||
      typeof parsed.entryDate !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("Cursor is missing required ledger entry fields");
    }

    if (
      Number.isNaN(Date.parse(parsed.entryDate)) ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new Error("Cursor contains invalid ledger entry values");
    }

    return parsed;
  } catch (error) {
    throw new Error("Invalid ledger entry cursor");
  }
};

// ---------------------------------------------------------------------------
// Customer wallet balances with optimistic locking (#2291)
// ---------------------------------------------------------------------------

/** Retries after the first attempt when a wallet version conflict occurs. */
export const WALLET_UPDATE_MAX_RETRIES = 3;

export interface CustomerWallet {
  id: string;
  user_id: string;
  currency: string;
  /** Decimal string, exactly as stored (DECIMAL(20,7)). */
  balance: string;
  version: number;
}

/**
 * The wallet changed between our read and our write (its version moved on).
 * Thrown once retries are exhausted; the caller may retry the whole request.
 */
export class ConcurrentModificationError extends Error {
  constructor(
    readonly userId: string,
    readonly currency: string,
    readonly attempts: number,
  ) {
    super(
      `Wallet ${userId}/${currency} was modified concurrently; gave up after ${attempts} attempt(s)`,
    );
    this.name = "ConcurrentModificationError";
  }
}

export class InsufficientFundsError extends Error {
  constructor(
    readonly userId: string,
    readonly currency: string,
    readonly balance: string,
    readonly requested: string,
  ) {
    super(
      `Insufficient funds in wallet ${userId}/${currency}: balance ${balance}, requested ${requested}`,
    );
    this.name = "InsufficientFundsError";
  }
}

export class WalletNotFoundError extends Error {
  constructor(
    readonly userId: string,
    readonly currency: string,
  ) {
    super(`No ${currency} wallet for user ${userId}`);
    this.name = "WalletNotFoundError";
  }
}

const DECIMAL_AMOUNT_PATTERN = /^\d{1,13}(\.\d{1,7})?$/;

/**
 * Validate an amount and return it as a decimal string. Strings are preferred
 * so no float rounding touches the value; numbers are accepted for
 * convenience and must already fit the column's 7 decimal places.
 */
function toWalletAmount(amount: string | number): string {
  const text = typeof amount === "number" ? String(amount) : amount.trim();
  if (!DECIMAL_AMOUNT_PATTERN.test(text) || /^0+(\.0+)?$/.test(text)) {
    throw new Error(`Invalid wallet amount: ${amount}`);
  }
  return text;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    currency?: SupportedCurrency,
    conversionRate?: number,
  ): Promise<PostedEntry[]> {
    // Reject unbalanced journals before any database work, and leave an audit trail.
    try {
      validateLedgerEntries(entries, referenceNumber);
    } catch (error) {
      if (error instanceof UnbalancedLedgerException) {
        await recordUnbalancedAttempt(error, {
          referenceNumber,
          transactionId,
          postedBy,
          entries,
        });
      }
      throw error;
    }

    // Attach currency metadata if provided
    const enrichedEntries =
      currency && conversionRate
        ? entries.map((e) => ({
            ...e,
            metadata: {
              ...(e.metadata || {}),
              currency,
              conversionRate,
            },
          }))
        : entries;

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Call the database function to post atomically
      const result = await client.query(
        `SELECT * FROM post_transaction($1, $2, $3, $4, $5)`,
        [
          referenceNumber,
          description,
          transactionId || null,
          postedBy || null,
          JSON.stringify(enrichedEntries),
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

      // Defence in depth: post_transaction() enforces the same invariant in SQL.
      if (
        !(error instanceof UnbalancedLedgerException) &&
        error instanceof Error &&
        /not balanced/i.test(error.message)
      ) {
        const totals = entries.reduce(
          (t, e) => ({
            d: t.d + (e.debit_amount || 0),
            c: t.c + (e.credit_amount || 0),
          }),
          { d: 0, c: 0 },
        );
        const exception = new UnbalancedLedgerException(
          totals.d.toFixed(7),
          totals.c.toFixed(7),
          (totals.d - totals.c).toFixed(7),
          referenceNumber,
        );
        await recordUnbalancedAttempt(exception, {
          referenceNumber,
          transactionId,
          postedBy,
          entries,
        });
        throw exception;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  /* Duplicate block removed */

  /**
   * Post a deposit transaction.
   * Convenience wrapper that calls postDepositWithCurrency with BASE_CURRENCY (USD).
   */
  async postDeposit(
    amount: number,
    fee: number,
    referenceNumber: string,
    transactionId: string,
    userId: string,
  ): Promise<PostedEntry[]> {
    return this.postDepositWithCurrency(
      amount,
      fee,
      BASE_CURRENCY,
      referenceNumber,
      transactionId,
      userId,
    );
  }

  /**
   * Post a deposit transaction with currency conversion.
   * `amount` and `fee` are in the original `currency`.
   * The amounts are converted to base currency (USD) for ledger accounting.
   * Metadata records original currency and conversion rate.
   */
  async postDepositWithCurrency(
    amount: number,
    fee: number,
    currency: SupportedCurrency,
    referenceNumber: string,
    transactionId: string,
    userId: string,
  ): Promise<PostedEntry[]> {
    // Determine settlement delay from user
    const userModel = new UserModel();
    const user = await userModel.findById(userId);
    const delayDays = user?.settlementDelayDays || 0;

    // Calculate settlement date
    const settlementDate = new Date();
    settlementDate.setDate(settlementDate.getDate() + delayDays);
    const settlementDateStr = settlementDate.toISOString().split("T")[0];

    // Compute conversion to base currency (USD) for amount and fee
    const amountConversion = currencyService.convertToBase(amount, currency);
    const feeConversion = currencyService.convertToBase(fee, currency);

    const entries: LedgerEntry[] = [
      {
        account_code: "1100", // Mobile Money Float
        debit_amount: amountConversion.convertedAmount,
        description: "Customer deposit received",
        metadata: {
          originalAmount: amount,
          originalCurrency: currency,
          conversionRate: amountConversion.rate,
        },
      },
      {
        account_code: "2000", // Customer Balances
        credit_amount:
          amountConversion.convertedAmount - feeConversion.convertedAmount,
        description: "Customer balance credited",
        settlement_date: settlementDateStr,
        metadata: {
          originalAmount: amount - fee,
          originalCurrency: currency,
          conversionRate: amountConversion.rate,
        },
      },
    ];

    // Add fee revenue if applicable
    if (fee > 0) {
      entries.push({
        account_code: "4100", // Deposit Fee Revenue
        credit_amount: feeConversion.convertedAmount,
        description: "Deposit fee earned",
        metadata: {
          originalAmount: fee,
          originalCurrency: currency,
          conversionRate: feeConversion.rate,
        },
      });
    }

    return this.postTransaction(
      referenceNumber,
      `Deposit: ${amount} ${currency} (fee: ${fee} ${currency})`,
      entries,
      transactionId,
      userId,
      currency,
      amountConversion.rate,
    );
  }

  /**
   * Post a withdrawal transaction.
   * Convenience wrapper that calls postWithdrawalWithCurrency with BASE_CURRENCY (USD).
   */
  async postWithdrawal(
    amount: number,
    fee: number,
    referenceNumber: string,
    transactionId: string,
    userId: string,
  ): Promise<PostedEntry[]> {
    return this.postWithdrawalWithCurrency(
      amount,
      fee,
      BASE_CURRENCY,
      referenceNumber,
      transactionId,
      userId,
    );
  }

  /**
   * Post a withdrawal transaction with currency conversion.
   * `amount` and `fee` are in the original `currency`.
   * The amounts are converted to base currency (USD) for ledger accounting.
   * Metadata records original currency and conversion rate.
   */
  async postWithdrawalWithCurrency(
    amount: number,
    fee: number,
    currency: SupportedCurrency,
    referenceNumber: string,
    transactionId: string,
    userId: string,
  ): Promise<PostedEntry[]> {
    // Compute conversion to base currency (USD) for amount and fee
    const amountConversion = currencyService.convertToBase(amount, currency);
    const feeConversion = currencyService.convertToBase(fee, currency);

    const entries: LedgerEntry[] = [
      {
        account_code: "2000", // Customer Balances
        debit_amount:
          amountConversion.convertedAmount + feeConversion.convertedAmount,
        description: "Customer balance debited",
        metadata: {
          originalAmount: amount + fee,
          originalCurrency: currency,
          conversionRate: amountConversion.rate,
        },
      },
      {
        account_code: "1100", // Mobile Money Float
        credit_amount: amountConversion.convertedAmount,
        description: "Withdrawal paid out",
        metadata: {
          originalAmount: amount,
          originalCurrency: currency,
          conversionRate: amountConversion.rate,
        },
      },
    ];

    // Add fee revenue if applicable
    if (fee > 0) {
      entries.push({
        account_code: "4200", // Withdrawal Fee Revenue
        credit_amount: feeConversion.convertedAmount,
        description: "Withdrawal fee earned",
        metadata: {
          originalAmount: fee,
          originalCurrency: currency,
          conversionRate: feeConversion.rate,
        },
      });
    }

    return this.postTransaction(
      referenceNumber,
      `Withdrawal: ${amount} ${currency} (fee: ${fee} ${currency})`,
      entries,
      transactionId,
      userId,
      currency,
      amountConversion.rate,
    );
  }

  /**
   * Post an automatic refund for a permanently failed telecom payout.
   * The entries restore the user's wallet balance and record the blockchain
   * refund hash in metadata for later reconciliation.
   */
  async postWithdrawalRefund(
    amount: number,
    referenceNumber: string,
    transactionId: string,
    userId: string,
    reason: string,
    refundHash?: string,
  ): Promise<PostedEntry[]> {
    const refundReference = `REFUND-${referenceNumber}`;
    const entries: LedgerEntry[] = [
      {
        account_code: "1100", // Mobile Money Float
        debit_amount: amount,
        description: "Failed payout funds returned",
        metadata: {
          originalReferenceNumber: referenceNumber,
          reason,
          refundHash,
        },
      },
      {
        account_code: "2000", // Customer Balances
        credit_amount: amount,
        description: "Customer wallet refund credited",
        metadata: {
          originalReferenceNumber: referenceNumber,
          reason,
          refundHash,
        },
      },
    ];

    return this.postTransaction(
      refundReference,
      `Failed payout refund: ${amount} - Reason: ${reason}`,
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
   * Fetch a customer's wallet for one currency, or null if none exists.
   */
  async getWallet(
    userId: string,
    currency: string,
  ): Promise<CustomerWallet | null> {
    const result = await this.pool.query<CustomerWallet>(
      `SELECT id, user_id, currency, balance::text AS balance, version
         FROM customer_wallets
        WHERE user_id = $1 AND currency = $2`,
      [userId, currency],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Deduct `amount` from a customer's wallet. Safe under concurrent
   * withdrawals: see applyWalletDelta.
   *
   * @throws InsufficientFundsError, WalletNotFoundError,
   *         ConcurrentModificationError (after WALLET_UPDATE_MAX_RETRIES)
   */
  async debitWallet(
    userId: string,
    currency: string,
    amount: string | number,
    client?: PoolClient,
  ): Promise<CustomerWallet> {
    return this.applyWalletDelta(userId, currency, amount, -1, client);
  }

  /** Add `amount` to a customer's wallet (optimistically locked). */
  async creditWallet(
    userId: string,
    currency: string,
    amount: string | number,
    client?: PoolClient,
  ): Promise<CustomerWallet> {
    return this.applyWalletDelta(userId, currency, amount, 1, client);
  }

  /**
   * Optimistic-locking read-modify-write of a wallet balance.
   *
   * 1. Read the balance and its `version`, and decide sufficiency against
   *    that snapshot.
   * 2. `UPDATE ... SET version = version + 1 WHERE id = $id AND version = $read`.
   *    If another writer committed in between, the version no longer matches,
   *    no row is updated, and nothing is written based on a stale balance.
   * 3. On such a conflict, back off briefly and retry from step 1, up to
   *    WALLET_UPDATE_MAX_RETRIES times, then throw ConcurrentModificationError.
   *
   * Pass `client` to run inside a caller's transaction. Use READ COMMITTED
   * (the default): under REPEATABLE READ a retry would re-read the same
   * snapshot, and Postgres raises a serialization error instead.
   */
  private async applyWalletDelta(
    userId: string,
    currency: string,
    amount: string | number,
    sign: 1 | -1,
    client?: PoolClient,
  ): Promise<CustomerWallet> {
    const value = toWalletAmount(amount);
    const db = client ?? this.pool;
    const maxAttempts = WALLET_UPDATE_MAX_RETRIES + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const read = await db.query<CustomerWallet & { sufficient: boolean }>(
        `SELECT id, user_id, currency, balance::text AS balance, version,
                balance + ($3::numeric * $4) >= 0 AS sufficient
           FROM customer_wallets
          WHERE user_id = $1 AND currency = $2`,
        [userId, currency, value, sign],
      );
      const wallet = read.rows[0];
      if (!wallet) throw new WalletNotFoundError(userId, currency);
      if (!wallet.sufficient) {
        throw new InsufficientFundsError(userId, currency, wallet.balance, value);
      }

      const updated = await db.query<CustomerWallet>(
        `UPDATE customer_wallets
            SET balance    = balance + ($2::numeric * $3),
                version    = version + 1,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND version = $4
          RETURNING id, user_id, currency, balance::text AS balance, version`,
        [wallet.id, value, sign, wallet.version],
      );
      if (updated.rowCount === 1) return updated.rows[0];

      if (attempt < maxAttempts) {
        // Jittered backoff so colliding writers don't retry in lockstep.
        await sleep(Math.random() * 10 * attempt);
      }
    }

    throw new ConcurrentModificationError(userId, currency, maxAttempts);
  }

  /**
   * Get account balance as of a specific date
   */
  async getAccountBalance(
    accountCode: string,
    asOfDate?: Date,
  ): Promise<number> {
    // Same DATE-parameter timezone concern as getTrialBalance above —
    // pass an explicit UTC "YYYY-MM-DD" string, not a raw JS Date.
    const dateParam = (asOfDate ?? new Date()).toISOString().slice(0, 10);
    const result = await this.pool.query(
      "SELECT get_account_balance($1, $2) as balance",
      [accountCode, dateParam],
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
    // get_trial_balance's p_as_of_date parameter is a plain SQL DATE (no
    // time/timezone component). Passing a JS Date object directly here lets
    // the pg driver's timezone-sensitive serialization shift the calendar
    // date by ±1 day depending on the server process's local timezone
    // offset relative to UTC — especially near midnight. Extracting the
    // UTC calendar date as an explicit "YYYY-MM-DD" string removes that
    // ambiguity: the caller's intended calendar date (e.g. CLI --date=)
    // is always what gets sent, regardless of server timezone.
    const dateParam = (asOfDate ?? new Date()).toISOString().slice(0, 10);
    const result = await this.pool.query(
      "SELECT * FROM get_trial_balance($1)",
      [dateParam],
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
    } = {},
  ): Promise<LedgerEntryPage> {
    const pageLimit = normalizeLimit(
      options.limit ?? DEFAULT_LEDGER_ENTRY_LIMIT,
    );
    const cursor = options.cursor
      ? decodeLedgerEntryCursor(options.cursor)
      : null;
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
        queryLimit,
      ],
    );

    const rows = result.rows as LedgerEntryRow[];
    const hasMore = rows.length > pageLimit;
    const entries = hasMore ? rows.slice(0, pageLimit) : rows;

    return {
      entries,
      nextCursor: hasMore
        ? encodeLedgerEntryCursor(entries[entries.length - 1])
        : null,
      hasMore,
      limit: pageLimit,
    };
  }

  /**
   * Compute 30-day payout velocity per provider from the ledger.
   * Returns total credit amount on account 1100 (Mobile Money Float) per provider.
   */
  private async get30DayVelocityByProvider(): Promise<Map<string, number>> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await this.pool.query<{ provider: string; volume: string }>(
      `SELECT
         COALESCE(le.metadata->>'provider', 'unknown') AS provider,
         SUM(le.credit_amount)                         AS volume
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       WHERE a.code = '1100'
         AND le.entry_date >= $1
       GROUP BY le.metadata->>'provider'`,
      [since],
    );
    const map = new Map<string, number>();
    for (const row of result.rows) {
      map.set(row.provider, parseFloat(row.volume) || 0);
    }
    return map;
  }

  /**
   * Seasonal peak multiplier: boost expected volume by RESERVE_SEASONAL_PEAK_MULTIPLIER
   * during months declared as peak (default: December=12 and April=4 for
   * African mobile-money holiday cycles). Configurable via env vars.
   */
  private seasonalMultiplier(): number {
    const peakMonths = (process.env.RESERVE_PEAK_MONTHS || "12,4")
      .split(",")
      .map((m) => parseInt(m.trim(), 10));
    const currentMonth = new Date().getMonth() + 1; // 1-based
    if (peakMonths.includes(currentMonth)) {
      return parseFloat(process.env.RESERVE_SEASONAL_PEAK_MULTIPLIER || "1.25");
    }
    return 1;
  }

  /**
   * Check reserve liquidity for each provider.
   * Triggers PagerDuty + Slack alerts when wallet balance / (30-day volume) < 110%.
   *
   * @param walletBalances  map of provider → current wallet balance (same currency as ledger)
   */
  async checkReserveLiquidity(
    walletBalances: Record<string, number>,
  ): Promise<void> {
    const RATIO_THRESHOLD = parseFloat(
      process.env.RESERVE_LIQUIDITY_RATIO || "1.1",
    );
    const velocity = await this.get30DayVelocityByProvider();
    const seasonal = this.seasonalMultiplier();
    const pagerDuty = createPagerDutyService();

    for (const [provider, balance] of Object.entries(walletBalances)) {
      const rawVolume = velocity.get(provider) ?? 0;
      if (rawVolume === 0) continue; // no recent activity — skip

      const expectedVolume = rawVolume * seasonal;
      const ratio = balance / expectedVolume;

      if (ratio < RATIO_THRESHOLD) {
        const shortfallAmount = expectedVolume * RATIO_THRESHOLD - balance;

        // PagerDuty alert
        await pagerDuty.handleBalanceShortfall(
          provider,
          "reserve-liquidity",
          expectedVolume * RATIO_THRESHOLD,
          balance,
        );

        // Slack alert
        await notifySlackAlert(
          {
            statusCode: 500,
            method: "MONITOR",
            path: `/reserve-liquidity/${provider}`,
            timestamp: new Date().toISOString(),
            error: new Error(
              `Reserve liquidity below 110%: ${provider} balance=${balance.toFixed(2)} ` +
                `expected=${expectedVolume.toFixed(2)} ratio=${(ratio * 100).toFixed(1)}% ` +
                `shortfall=${shortfallAmount.toFixed(2)} seasonal_mult=${seasonal}`,
            ),
          },
          { appName: "reserve-liquidity-monitor" },
        );
      }
    }
  }
}

// Export singleton instance
export const ledgerService = new LedgerService();
