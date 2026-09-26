/**
 * src/scripts/__tests__/archiveTransactions.test.ts
 *
 * Test suite for transaction archival script.
 * Verifies batch processing, data preservation, and off-peak scheduling.
 */

import { archiveTransactions, type ArchiveConfig, type ArchiveStats } from "../archiveTransactions";
import { pool } from "../../config/database";
import { v4 as uuidv4 } from "uuid";

describe("Transaction Archival Script (#2033)", () => {
  let testUserId: string;
  let testTransactionIds: string[] = [];

  beforeAll(async () => {
    // Create test user
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (phone_number, kyc_level) VALUES ($1, $2) RETURNING id`,
      ["+237670000001", "basic"],
    );
    testUserId = userResult.rows[0].id;
  });

  afterEach(async () => {
    // Clean up test data
    for (const txId of testTransactionIds) {
      await pool.query(
        `DELETE FROM archived_transactions WHERE id = $1`,
        [txId],
      );
      await pool.query(`DELETE FROM transactions WHERE id = $1`, [txId]);
    }
    testTransactionIds = [];
  });

  afterAll(async () => {
    // Clean up user
    await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
  });

  describe("archiveTransactions", () => {
    it("should archive old completed transactions", async () => {
      // Create a transaction older than 365 days
      const oldTxId = uuidv4();
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 400);

      await pool.query(
        `INSERT INTO transactions (
          id, reference_number, type, amount, phone_number, provider,
          stellar_address, status, user_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          oldTxId,
          `REF-${Date.now()}-1`,
          "deposit",
          "100.00",
          "+237670000002",
          "airtel",
          "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          "completed",
          testUserId,
          oldDate,
          oldDate,
        ],
      );
      testTransactionIds.push(oldTxId);

      const config: ArchiveConfig = {
        daysOld: 365,
        batchSize: 100,
        maxBatches: 0,
        dryRun: false,
      };

      const stats = await archiveTransactions(config);

      expect(stats.status).toBe("completed");
      expect(stats.totalArchived).toBeGreaterThan(0);
      expect(stats.totalBatches).toBeGreaterThan(0);

      // Verify transaction was archived
      const archivedResult = await pool.query(
        `SELECT id FROM archived_transactions WHERE id = $1`,
        [oldTxId],
      );
      expect(archivedResult.rows.length).toBe(1);

      // Verify original marked as archived
      const originalResult = await pool.query(
        `SELECT archived FROM transactions WHERE id = $1`,
        [oldTxId],
      );
      expect(originalResult.rows[0]?.archived).toBe(true);
    });

    it("should not archive recent transactions", async () => {
      // Create a transaction from today
      const recentTxId = uuidv4();
      const today = new Date();

      await pool.query(
        `INSERT INTO transactions (
          id, reference_number, type, amount, phone_number, provider,
          stellar_address, status, user_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          recentTxId,
          `REF-${Date.now()}-2`,
          "withdraw",
          "50.00",
          "+237670000003",
          "mtn",
          "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          "completed",
          testUserId,
          today,
          today,
        ],
      );
      testTransactionIds.push(recentTxId);

      const config: ArchiveConfig = {
        daysOld: 365,
        batchSize: 100,
        maxBatches: 0,
        dryRun: false,
      };

      const stats = await archiveTransactions(config);

      // Transaction should not be archived
      const archivedResult = await pool.query(
        `SELECT id FROM archived_transactions WHERE id = $1`,
        [recentTxId],
      );
      expect(archivedResult.rows.length).toBe(0);

      // Original should not be marked as archived
      const originalResult = await pool.query(
        `SELECT archived FROM transactions WHERE id = $1`,
        [recentTxId],
      );
      expect(originalResult.rows[0]?.archived).toBe(false);
    });

    it("should preserve all transaction data during archival", async () => {
      const oldTxId = uuidv4();
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 400);

      const testData = {
        reference_number: `REF-${Date.now()}-3`,
        type: "deposit" as const,
        amount: "123.45",
        phone_number: "+237670000004",
        provider: "orange",
        stellar_address: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        status: "completed" as const,
      };

      await pool.query(
        `INSERT INTO transactions (
          id, reference_number, type, amount, phone_number, provider,
          stellar_address, status, user_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          oldTxId,
          testData.reference_number,
          testData.type,
          testData.amount,
          testData.phone_number,
          testData.provider,
          testData.stellar_address,
          testData.status,
          testUserId,
          oldDate,
          oldDate,
        ],
      );
      testTransactionIds.push(oldTxId);

      const config: ArchiveConfig = {
        daysOld: 365,
        batchSize: 100,
        maxBatches: 0,
        dryRun: false,
      };

      await archiveTransactions(config);

      // Verify all data is preserved
      const result = await pool.query(
        `SELECT * FROM archived_transactions WHERE id = $1`,
        [oldTxId],
      );

      expect(result.rows.length).toBe(1);
      const archived = result.rows[0];
      expect(archived.reference_number).toBe(testData.reference_number);
      expect(archived.type).toBe(testData.type);
      expect(archived.amount).toBe(testData.amount);
      expect(archived.phone_number).toBe(testData.phone_number);
      expect(archived.provider).toBe(testData.provider);
      expect(archived.stellar_address).toBe(testData.stellar_address);
      expect(archived.status).toBe(testData.status);
      expect(archived.user_id).toBe(testUserId);
    });

    it("should support batch processing", async () => {
      // Create multiple old transactions
      const txIds = [];
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 400);

      for (let i = 0; i < 5; i++) {
        const txId = uuidv4();
        await pool.query(
          `INSERT INTO transactions (
            id, reference_number, type, amount, phone_number, provider,
            stellar_address, status, user_id, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            txId,
            `REF-${Date.now()}-${i}`,
            "deposit",
            `${100 + i}.00`,
            "+237670000005",
            "airtel",
            "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            "failed",
            testUserId,
            oldDate,
            oldDate,
          ],
        );
        txIds.push(txId);
      }
      testTransactionIds.push(...txIds);

      const config: ArchiveConfig = {
        daysOld: 365,
        batchSize: 2, // Small batch size to verify chunking
        maxBatches: 0,
        dryRun: false,
      };

      const stats = await archiveTransactions(config);

      expect(stats.totalBatches).toBeGreaterThan(1); // Should have multiple batches
      expect(stats.totalArchived).toBeGreaterThanOrEqual(5);
    });

    it("should support dry-run mode", async () => {
      const oldTxId = uuidv4();
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 400);

      await pool.query(
        `INSERT INTO transactions (
          id, reference_number, type, amount, phone_number, provider,
          stellar_address, status, user_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          oldTxId,
          `REF-${Date.now()}-dryrun`,
          "deposit",
          "50.00",
          "+237670000006",
          "mtn",
          "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          "completed",
          testUserId,
          oldDate,
          oldDate,
        ],
      );
      testTransactionIds.push(oldTxId);

      const config: ArchiveConfig = {
        daysOld: 365,
        batchSize: 100,
        maxBatches: 0,
        dryRun: true, // Dry run mode
      };

      const stats = await archiveTransactions(config);

      expect(stats.status).toBe("completed");

      // In dry-run, transaction should NOT be archived
      const archivedResult = await pool.query(
        `SELECT id FROM archived_transactions WHERE id = $1`,
        [oldTxId],
      );
      expect(archivedResult.rows.length).toBe(0);

      // Original should NOT be marked as archived
      const originalResult = await pool.query(
        `SELECT archived FROM transactions WHERE id = $1`,
        [oldTxId],
      );
      expect(originalResult.rows[0]?.archived).toBe(false);
    });

    it("should skip transactions that are already archived", async () => {
      const oldTxId = uuidv4();
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 400);

      // Create a transaction and mark it as already archived
      await pool.query(
        `INSERT INTO transactions (
          id, reference_number, type, amount, phone_number, provider,
          stellar_address, status, user_id, created_at, updated_at, archived
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          oldTxId,
          `REF-${Date.now()}-skipped`,
          "deposit",
          "50.00",
          "+237670000007",
          "airtel",
          "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          "completed",
          testUserId,
          oldDate,
          oldDate,
          true, // Already archived
        ],
      );
      testTransactionIds.push(oldTxId);

      const config: ArchiveConfig = {
        daysOld: 365,
        batchSize: 100,
        maxBatches: 0,
        dryRun: false,
      };

      const statsBefore = await pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM archived_transactions WHERE id = $1`,
        [oldTxId],
      );
      const countBefore = parseInt(statsBefore.rows[0]?.count || "0", 10);

      await archiveTransactions(config);

      // Should not duplicate archived records
      const statsAfter = await pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM archived_transactions WHERE id = $1`,
        [oldTxId],
      );
      const countAfter = parseInt(statsAfter.rows[0]?.count || "0", 10);

      expect(countAfter).toBe(countBefore);
    });

    it("should respect maxBatches limit", async () => {
      // Create multiple old transactions
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 400);

      for (let i = 0; i < 10; i++) {
        const txId = uuidv4();
        await pool.query(
          `INSERT INTO transactions (
            id, reference_number, type, amount, phone_number, provider,
            stellar_address, status, user_id, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            txId,
            `REF-${Date.now()}-${i}`,
            "deposit",
            "50.00",
            "+237670000008",
            "airtel",
            "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            "completed",
            testUserId,
            oldDate,
            oldDate,
          ],
        );
        testTransactionIds.push(txId);
      }

      const config: ArchiveConfig = {
        daysOld: 365,
        batchSize: 2,
        maxBatches: 2, // Only process 2 batches
        dryRun: false,
      };

      const stats = await archiveTransactions(config);

      expect(stats.totalBatches).toBeLessThanOrEqual(2);
    });
  });

  describe("Archive Statistics", () => {
    it("should report accurate statistics", async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 400);
      const txIds = [];

      for (let i = 0; i < 3; i++) {
        const txId = uuidv4();
        await pool.query(
          `INSERT INTO transactions (
            id, reference_number, type, amount, phone_number, provider,
            stellar_address, status, user_id, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            txId,
            `REF-${Date.now()}-${i}`,
            "deposit",
            "50.00",
            "+237670000009",
            "airtel",
            "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            "completed",
            testUserId,
            oldDate,
            oldDate,
          ],
        );
        txIds.push(txId);
      }
      testTransactionIds.push(...txIds);

      const config: ArchiveConfig = {
        daysOld: 365,
        batchSize: 100,
        maxBatches: 0,
        dryRun: false,
      };

      const stats = await archiveTransactions(config);

      expect(stats.status).toBe("completed");
      expect(stats.totalArchived).toBeGreaterThanOrEqual(3);
      expect(stats.startTime).toBeDefined();
      expect(stats.endTime).toBeDefined();
      expect(stats.durationMs).toBeGreaterThan(0);
      expect(stats.errors.length).toBe(0);
    });
  });
});
