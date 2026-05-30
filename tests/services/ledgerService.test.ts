// Import the service under test
import { LedgerService, LedgerEntry } from '../../src/services/ledgerService';
// Mock the database pool to avoid real DB interactions
jest.mock('../../src/config/database', () => ({
  pool: {
    query: jest.fn(),
    end: jest.fn()
  }
}));
import { pool } from '../../src/config/database';

describe('LedgerService', () => {
  let ledgerService: LedgerService;
  let testTransactionId: string;
  let testUserId: string;

  beforeAll(async () => {
    ledgerService = new LedgerService();
    // Mock pool query responses for user creation and transaction creation
    const mockQuery = pool.query as jest.Mock;
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'mock-user-id' }] }) // userResult
      .mockResolvedValueOnce({ rows: [{ id: 'mock-tx-id' }] }); // txResult
    testUserId = 'mock-user-id';
    testTransactionId = 'mock-tx-id';
  });

  afterAll(async () => {
    // End mock pool
    await pool.end();
  });

  afterEach(() => {
    // Reset mock calls between tests
    (pool.query as jest.Mock).mockReset();
  });

  describe('postTransaction', () => {
    it('should post a balanced double-entry transaction', async () => {
      const entries: LedgerEntry[] = [
        {
          account_code: '1100', // Mobile Money Float
          debit_amount: 100,
          description: 'Test debit'
        },
        {
          account_code: '2000', // Customer Balances
          credit_amount: 100,
          description: 'Test credit'
        }
      ];

      const result = await ledgerService.postTransaction(
        'TEST-REF-002',
        'Test transaction',
        entries,
        testTransactionId,
        testUserId
      );

      expect(result).toHaveLength(2);
      expect(result[0].account_code).toBe('1100');
      expect(result[0].debit).toBe(100);
      expect(result[1].account_code).toBe('2000');
      expect(result[1].credit).toBe(100);
    });

    it('should reject unbalanced transactions', async () => {
      const entries: LedgerEntry[] = [
        {
          account_code: '1100',
          debit_amount: 100
        },
        {
          account_code: '2000',
          credit_amount: 90 // Unbalanced!
        }
      ];

      await expect(
        ledgerService.postTransaction(
          'TEST-REF-003',
          'Unbalanced test',
          entries,
          testTransactionId,
          testUserId
        )
      ).rejects.toThrow(/not balanced/i);
    });

    it('should reject transactions with less than 2 entries', async () => {
      const entries: LedgerEntry[] = [
        {
          account_code: '1100',
          debit_amount: 100
        }
      ];

      await expect(
        ledgerService.postTransaction(
          'TEST-REF-004',
          'Single entry test',
          entries,
          testTransactionId,
          testUserId
        )
      ).rejects.toThrow(/at least 2 entries/i);
    });

    it('should reject transactions with invalid account codes', async () => {
      const entries: LedgerEntry[] = [
        {
          account_code: 'INVALID',
          debit_amount: 100
        },
        {
          account_code: '2000',
          credit_amount: 100
        }
      ];

      await expect(
        ledgerService.postTransaction(
          'TEST-REF-005',
          'Invalid account test',
          entries,
          testTransactionId,
          testUserId
        )
      ).rejects.toThrow(/account not found/i);
    });

    it('should handle complex multi-entry transactions', async () => {
      const entries: LedgerEntry[] = [
        {
          account_code: '1100', // Mobile Money Float
          debit_amount: 100
        },
        {
          account_code: '2000', // Customer Balances
          credit_amount: 95
        },
        {
          account_code: '4100', // Deposit Fee Revenue
          credit_amount: 5
        }
      ];

      const result = await ledgerService.postTransaction(
        'TEST-REF-006',
        'Multi-entry test',
        entries,
        testTransactionId,
        testUserId
      );

      expect(result).toHaveLength(3);
      
      const totalDebits = result.reduce((sum, e) => sum + e.debit, 0);
      const totalCredits = result.reduce((sum, e) => sum + e.credit, 0);
      expect(totalDebits).toBe(totalCredits);
    });
  });

  describe('postDeposit', () => {
    it('should post a deposit transaction correctly', async () => {
      const result = await ledgerService.postDeposit(
        100,
        5,
        'TEST-REF-007',
        testTransactionId,
        testUserId
      );

      expect(result).toHaveLength(3);
      
      // Check debit to Mobile Money Float
      const floatEntry = result.find(e => e.account_code === '1100');
      expect(floatEntry?.debit).toBe(100);

      // Check credit to Customer Balances
      const customerEntry = result.find(e => e.account_code === '2000');
      expect(customerEntry?.credit).toBe(95);

      // Check credit to Fee Revenue
      const feeEntry = result.find(e => e.account_code === '4100');
      expect(feeEntry?.credit).toBe(5);
    });

    it('should post deposit without fee', async () => {
      const result = await ledgerService.postDeposit(
        100,
        0,
        'TEST-REF-008',
        testTransactionId,
        testUserId
      );

      expect(result).toHaveLength(2); // No fee entry
    });
  });

  describe('postWithdrawal', () => {
    it('should post a withdrawal transaction correctly', async () => {
      const result = await ledgerService.postWithdrawal(
        100,
        5,
        'TEST-REF-009',
        testTransactionId,
        testUserId
      );

      expect(result).toHaveLength(3);
      
      // Check debit to Customer Balances
      const customerEntry = result.find(e => e.account_code === '2000');
      expect(customerEntry?.debit).toBe(105);

      // Check credit to Mobile Money Float
      const floatEntry = result.find(e => e.account_code === '1100');
      expect(floatEntry?.credit).toBe(100);

      // Check credit to Fee Revenue
      const feeEntry = result.find(e => e.account_code === '4200');
      expect(feeEntry?.credit).toBe(5);
    });
  });

  describe('getAccountBalance', () => {
    it('should return correct account balance', async () => {
      // Post a known transaction
      await ledgerService.postTransaction(
        'TEST-REF-010',
        'Balance test',
        [
          { account_code: '1100', debit_amount: 500 },
          { account_code: '2000', credit_amount: 500 }
        ],
        testTransactionId,
        testUserId
      );

      const balance = await ledgerService.getAccountBalance('1100');
      expect(balance).toBeGreaterThanOrEqual(500);
    });
  });

  describe('checkLedgerBalance', () => {
    it('should confirm ledger is balanced', async () => {
      const result = await ledgerService.checkLedgerBalance();
      
      expect(result.is_balanced).toBe(true);
      expect(result.total_debits).toBe(result.total_credits);
      expect(Math.abs(result.difference)).toBeLessThan(0.0000001);
    });
  });

  describe('getTrialBalance', () => {
    it('should return trial balance with all accounts', async () => {
      const trialBalance = await ledgerService.getTrialBalance();
      
      expect(Array.isArray(trialBalance)).toBe(true);
      expect(trialBalance.length).toBeGreaterThan(0);

      // Verify structure
      const firstAccount = trialBalance[0];
      expect(firstAccount).toHaveProperty('account_code');
      expect(firstAccount).toHaveProperty('account_name');
      expect(firstAccount).toHaveProperty('account_type');
      expect(firstAccount).toHaveProperty('debit_balance');
      expect(firstAccount).toHaveProperty('credit_balance');

      // Verify trial balance is balanced
      const totalDebits = trialBalance.reduce((sum, a) => sum + a.debit_balance, 0);
      const totalCredits = trialBalance.reduce((sum, a) => sum + a.credit_balance, 0);
      expect(Math.abs(totalDebits - totalCredits)).toBeLessThan(0.01);
    });
  });

  describe('getEntriesByTransaction', () => {
    it('should return all entries for a transaction', async () => {
      // Post a transaction
      await ledgerService.postTransaction(
        'TEST-REF-011',
        'Entry retrieval test',
        [
          { account_code: '1100', debit_amount: 200 },
          { account_code: '2000', credit_amount: 200 }
        ],
        testTransactionId,
        testUserId
      );

      const entries = await ledgerService.getEntriesByTransaction(testTransactionId);
      
      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(entries[0]).toHaveProperty('account_code');
      expect(entries[0]).toHaveProperty('debit_amount');
      expect(entries[0]).toHaveProperty('credit_amount');
    });
  });

  describe('getEntriesByAccount', () => {
    it('should return entries for a specific account', async () => {
      const entries = await ledgerService.getEntriesByAccount('1100', undefined, undefined, 10);
      
      expect(Array.isArray(entries)).toBe(true);
      entries.forEach(entry => {
        expect(entry.account_code).toBe('1100');
      });
    });

    it('should filter entries by date range', async () => {
      const startDate = new Date('2026-04-01');
      const endDate = new Date('2026-04-30');
      
      const entries = await ledgerService.getEntriesByAccount('1100', startDate, endDate, 100);
      
      entries.forEach(entry => {
        const entryDate = new Date(entry.entry_date);
        expect(entryDate >= startDate).toBe(true);
        expect(entryDate <= endDate).toBe(true);
      });
    });
  });

  describe('immutability', () => {
    it('should prevent modification of ledger entries', async () => {
      // Post a transaction
      const result = await ledgerService.postTransaction(
        'TEST-REF-012',
        'Immutability test',
        [
          { account_code: '1100', debit_amount: 100 },
          { account_code: '2000', credit_amount: 100 }
        ],
        testTransactionId,
        testUserId
      );

      const entryId = result[0].entry_id;

      // Attempt to update should fail
      await expect(
        pool.query('UPDATE ledger_entries SET debit_amount = 200 WHERE id = $1', [entryId])
      ).rejects.toThrow(/immutable/i);
    });

    it('should prevent deletion of ledger entries', async () => {
      // Post a transaction
      const result = await ledgerService.postTransaction(
        'TEST-REF-013',
        'Deletion test',
        [
          { account_code: '1100', debit_amount: 100 },
          { account_code: '2000', credit_amount: 100 }
        ],
        testTransactionId,
        testUserId
      );

      const entryId = result[0].entry_id;

      // Attempt to delete should fail
      await expect(
        pool.query('DELETE FROM ledger_entries WHERE id = $1', [entryId])
      ).rejects.toThrow(/immutable/i);
    });
  });

  describe('refreshAccountBalances', () => {
    it('should refresh materialized view without error', async () => {
      await expect(ledgerService.refreshAccountBalances()).resolves.not.toThrow();
    });
  });

  describe('getAllAccountBalances', () => {
    it('should return all account balances from materialized view', async () => {
      await ledgerService.refreshAccountBalances();
      const balances = await ledgerService.getAllAccountBalances();
      
      expect(Array.isArray(balances)).toBe(true);
      expect(balances.length).toBeGreaterThan(0);

      balances.forEach(balance => {
        expect(balance).toHaveProperty('account_id');
        expect(balance).toHaveProperty('code');
        expect(balance).toHaveProperty('name');
        expect(balance).toHaveProperty('type');
        expect(balance).toHaveProperty('balance');
      });
    });
  });
});
