import { VaultModel } from "../models/vault";
import { pool } from "../config/database";

describe("Vault System", () => {
  let vaultModel: VaultModel;
  let testUserId: string;

  beforeAll(async () => {
    vaultModel = new VaultModel();

    // Create a test user
    const userResult = await pool.query(
      `INSERT INTO users (phone_number, kyc_level) 
       VALUES ($1, $2) 
       RETURNING id`,
      ["+1234567890", "basic"],
    );
    testUserId = userResult.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query("DELETE FROM vault_transactions WHERE user_id = $1", [
      testUserId,
    ]);
    await pool.query("DELETE FROM vaults WHERE user_id = $1", [testUserId]);
    await pool.query("DELETE FROM transactions WHERE user_id = $1", [
      testUserId,
    ]);
    await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
  });

  describe("Vault Creation", () => {
    it("should create a new vault successfully", async () => {
      const vaultData = {
        userId: testUserId,
        name: "Emergency Fund",
        description: "For unexpected expenses",
        targetAmount: "50000.00",
      };

      const vault = await vaultModel.create(vaultData);

      expect(vault).toBeDefined();
      expect(vault.name).toBe("Emergency Fund");
      expect(vault.balance).toBe("0");
      expect(vault.targetAmount).toBe("50000.00");
      expect(vault.isActive).toBe(true);
    });

    it("should prevent duplicate vault names for same user", async () => {
      const vaultData = {
        userId: testUserId,
        name: "Emergency Fund", // Same name as above
        description: "Duplicate name test",
      };

      await expect(vaultModel.create(vaultData)).rejects.toThrow();
    });

    it("should validate vault name requirements", async () => {
      const invalidVaultData = {
        userId: testUserId,
        name: "", // Empty name
        description: "Invalid name test",
      };

      await expect(vaultModel.create(invalidVaultData)).rejects.toThrow(
        "Vault name is required",
      );
    });
  });

  describe("Balance Summary", () => {
    it("should calculate correct balance summary", async () => {
      // Create some test transactions to establish main balance
      await pool.query(
        `INSERT INTO transactions (
          reference_number, type, amount, phone_number, provider, 
          stellar_address, status, user_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "TEST-DEPOSIT-001",
          "deposit",
          "10000.00",
          "+1234567890",
          "test",
          "GTEST123",
          "completed",
          testUserId,
        ],
      );

      const summary = await vaultModel.getUserBalanceSummary(testUserId);

      expect(summary).toBeDefined();
      expect(parseFloat(summary.mainBalance)).toBe(10000.0);
      expect(summary.vaultBalances).toHaveLength(1); // Emergency Fund from previous test
      expect(parseFloat(summary.totalBalance)).toBe(10000.0); // Main balance + vault balance (0)
    });
  });

  describe("Fund Transfers", () => {
    let vaultId: string;

    beforeAll(async () => {
      const vaults = await vaultModel.findByUserId(testUserId);
      vaultId = vaults[0].id;
    });

    it("should transfer funds from main to vault", async () => {
      const result = await vaultModel.transferFunds(
        testUserId,
        vaultId,
        "1000.00",
        "deposit",
        "Test deposit",
      );

      expect(result.vault.balance).toBe("1000.00");
      expect(result.vaultTransaction.type).toBe("deposit");
      expect(result.vaultTransaction.amount).toBe("1000.00");
    });

    it("should transfer funds from vault to main", async () => {
      const result = await vaultModel.transferFunds(
        testUserId,
        vaultId,
        "500.00",
        "withdraw",
        "Test withdrawal",
      );

      expect(result.vault.balance).toBe("500.00");
      expect(result.vaultTransaction.type).toBe("withdraw");
      expect(result.vaultTransaction.amount).toBe("500.00");
    });

    it("should prevent overdraft from vault", async () => {
      await expect(
        vaultModel.transferFunds(
          testUserId,
          vaultId,
          "1000.00", // More than current vault balance (500)
          "withdraw",
          "Overdraft test",
        ),
      ).rejects.toThrow("Insufficient vault balance");
    });

    it("should maintain ledger accuracy after transfers", async () => {
      const summary = await vaultModel.getUserBalanceSummary(testUserId);

      // Should have: 10000 initial - 1000 to vault + 500 from vault = 9500 main
      // Vault should have: 1000 - 500 = 500
      // Total: 9500 + 500 = 10000
      expect(parseFloat(summary.mainBalance)).toBe(9500.0);
      expect(parseFloat(summary.vaultBalances[0].balance)).toBe(500.0);
      expect(parseFloat(summary.totalBalance)).toBe(10000.0);
    });
  });

  describe("Vault Management", () => {
    let vaultId: string;

    beforeAll(async () => {
      const vaults = await vaultModel.findByUserId(testUserId);
      vaultId = vaults[0].id;
    });

    it("should update vault properties", async () => {
      const updatedVault = await vaultModel.updateVault(vaultId, {
        name: "Emergency Fund - Updated",
        description: "Updated description",
        targetAmount: "75000.00",
      });

      expect(updatedVault?.name).toBe("Emergency Fund - Updated");
      expect(updatedVault?.description).toBe("Updated description");
      expect(updatedVault?.targetAmount).toBe("75000.00");
    });

    it("should retrieve vault transaction history", async () => {
      const transactions = await vaultModel.getVaultTransactions(vaultId);

      expect(transactions).toHaveLength(2); // deposit and withdraw from previous tests
      expect(transactions[0].type).toBe("withdraw"); // Most recent first
      expect(transactions[1].type).toBe("deposit");
    });

    it("should prevent deletion of vault with balance", async () => {
      await expect(vaultModel.delete(vaultId)).rejects.toThrow(
        "Cannot delete vault with non-zero balance",
      );
    });
  });
});
