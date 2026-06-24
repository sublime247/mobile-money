import { pool, queryRead, queryWrite } from "../config/database";

export interface Vault {
  id: string;
  userId: string;
  name: string;
  description?: string;
  balance: string;
  targetAmount?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultTransaction {
  id: string;
  vaultId: string;
  userId: string;
  type: "deposit" | "withdraw";
  amount: string;
  description?: string;
  referenceId?: string;
  createdAt: Date;
}

export interface CreateVaultInput {
  userId: string;
  name: string;
  description?: string;
  targetAmount?: string;
}

export interface VaultTransferInput {
  vaultId: string;
  userId: string;
  type: "deposit" | "withdraw";
  amount: string;
  description?: string;
  referenceId?: string;
}

export interface UserBalanceSummary {
  mainBalance: string;
  vaultBalances: Array<{
    vaultId: string;
    vaultName: string;
    balance: string;
  }>;
  totalBalance: string;
}

const VAULT_SELECT_COLUMNS = `
  id,
  user_id AS "userId",
  name,
  description,
  balance::text AS balance,
  target_amount::text AS "targetAmount",
  is_active AS "isActive",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const VAULT_TRANSACTION_SELECT_COLUMNS = `
  id,
  vault_id AS "vaultId",
  user_id AS "userId",
  type,
  amount::text AS amount,
  description,
  reference_id AS "referenceId",
  created_at AS "createdAt"
`;

export class VaultModel {
  async create(data: CreateVaultInput): Promise<Vault> {
    // Validate name length and format
    if (!data.name || data.name.trim().length === 0) {
      throw new Error("Vault name is required");
    }
    if (data.name.length > 100) {
      throw new Error("Vault name cannot exceed 100 characters");
    }
    if (data.description && data.description.length > 1000) {
      throw new Error("Vault description cannot exceed 1000 characters");
    }

    const result = await queryWrite(
      `INSERT INTO vaults (user_id, name, description, target_amount)
       VALUES ($1, $2, $3, $4)
       RETURNING ${VAULT_SELECT_COLUMNS}`,
      [
        data.userId,
        data.name.trim(),
        data.description?.trim() || null,
        data.targetAmount || null,
      ],
    );

    return result.rows[0];
  }

  async findById(id: string): Promise<Vault | null> {
    const result = await queryRead(
      `SELECT ${VAULT_SELECT_COLUMNS}
       FROM vaults
       WHERE id = $1`,
      [id],
    );

    return result.rows[0] || null;
  }

  async findByUserId(userId: string, activeOnly = true): Promise<Vault[]> {
    let query = `SELECT ${VAULT_SELECT_COLUMNS} FROM vaults WHERE user_id = $1`;
    const params = [userId];

    if (activeOnly) {
      query += " AND is_active = true";
    }

    query += " ORDER BY created_at ASC";

    const result = await queryRead(query, params);
    return result.rows;
  }

  async findByUserAndName(userId: string, name: string): Promise<Vault | null> {
    const result = await queryRead(
      `SELECT ${VAULT_SELECT_COLUMNS}
       FROM vaults
       WHERE user_id = $1 AND name = $2`,
      [userId, name.trim()],
    );

    return result.rows[0] || null;
  }

  async updateBalance(
    vaultId: string,
    newBalance: string,
    client: any = pool,
  ): Promise<void> {
    await client.query(
      `UPDATE vaults 
       SET balance = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [newBalance, vaultId],
    );
  }

  async updateVault(
    id: string,
    updates: Partial<Pick<Vault, "name" | "description" | "targetAmount" | "isActive">>,
  ): Promise<Vault | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      if (!updates.name || updates.name.trim().length === 0) {
        throw new Error("Vault name is required");
      }
      if (updates.name.length > 100) {
        throw new Error("Vault name cannot exceed 100 characters");
      }
      fields.push(`name = $${paramIndex++}`);
      values.push(updates.name.trim());
    }

    if (updates.description !== undefined) {
      if (updates.description && updates.description.length > 1000) {
        throw new Error("Vault description cannot exceed 1000 characters");
      }
      fields.push(`description = $${paramIndex++}`);
      values.push(updates.description?.trim() || null);
    }

    if (updates.targetAmount !== undefined) {
      fields.push(`target_amount = $${paramIndex++}`);
      values.push(updates.targetAmount || null);
    }

    if (updates.isActive !== undefined) {
      fields.push(`is_active = $${paramIndex++}`);
      values.push(updates.isActive);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await queryWrite(
      `UPDATE vaults 
       SET ${fields.join(", ")}
       WHERE id = $${paramIndex}
       RETURNING ${VAULT_SELECT_COLUMNS}`,
      values,
    );

    return result.rows[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    // Check if vault has balance
    const vault = await this.findById(id);
    if (!vault) return false;

    if (parseFloat(vault.balance) > 0) {
      throw new Error("Cannot delete vault with non-zero balance");
    }

    const result = await queryWrite("DELETE FROM vaults WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async createVaultTransaction(
    data: VaultTransferInput,
    client: any = pool,
  ): Promise<VaultTransaction> {
    const result = await client.query(
      `INSERT INTO vault_transactions (vault_id, user_id, type, amount, description, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${VAULT_TRANSACTION_SELECT_COLUMNS}`,
      [
        data.vaultId,
        data.userId,
        data.type,
        data.amount,
        data.description || null,
        data.referenceId || null,
      ],
    );

    return result.rows[0];
  }

  async getVaultTransactions(
    vaultId: string,
    limit = 50,
    offset = 0,
  ): Promise<VaultTransaction[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const off = Math.max(offset, 0);

    const result = await queryRead(
      `SELECT ${VAULT_TRANSACTION_SELECT_COLUMNS}
       FROM vault_transactions
       WHERE vault_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [vaultId, capped, off],
    );

    return result.rows;
  }

  async getUserBalanceSummary(userId: string): Promise<UserBalanceSummary> {
    // Get main balance from completed transactions
    const mainBalanceResult = await queryRead(
      `SELECT COALESCE(SUM(
         CASE 
           WHEN type = 'deposit' THEN amount::numeric
           WHEN type = 'withdraw' THEN -amount::numeric
           ELSE 0
         END
       ), 0)::text AS balance
       FROM transactions
       WHERE user_id = $1 
         AND status = 'completed'
         AND vault_id IS NULL`,
      [userId],
    );

    const mainBalance = mainBalanceResult.rows[0]?.balance || "0";

    // Get vault balances
    const vaultBalancesResult = await queryRead(
      `SELECT id, name, balance::text AS balance
       FROM vaults
       WHERE user_id = $1 AND is_active = true
       ORDER BY created_at ASC`,
      [userId],
    );

    const vaultBalances = vaultBalancesResult.rows.map((row) => ({
      vaultId: row.id,
      vaultName: row.name,
      balance: row.balance,
    }));

    // Calculate total balance
    const totalBalance = (
      parseFloat(mainBalance) +
      vaultBalances.reduce((sum, vault) => sum + parseFloat(vault.balance), 0)
    ).toString();

    return {
      mainBalance,
      vaultBalances,
      totalBalance,
    };
  }

  /**
   * Transfer funds between main balance and vault (atomic operation)
   */
  async transferFunds(
    userId: string,
    vaultId: string,
    amount: string,
    type: "deposit" | "withdraw",
    description?: string,
  ): Promise<{ vault: Vault; vaultTransaction: VaultTransaction }> {
    const client = await pool.connect();
    
    try {
      await client.query("BEGIN");

      // Get current vault
      const vaultResult = await client.query(
        `SELECT ${VAULT_SELECT_COLUMNS} FROM vaults WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [vaultId, userId],
      );

      if (vaultResult.rows.length === 0) {
        throw new Error("Vault not found");
      }

      const vault = vaultResult.rows[0];
      if (!vault.isActive) {
        throw new Error("Cannot transfer to inactive vault");
      }

      const amountNum = parseFloat(amount);
      const currentBalance = parseFloat(vault.balance);

      // Validate transfer
      if (type === "withdraw" && currentBalance < amountNum) {
        throw new Error("Insufficient vault balance");
      }

      // Get main balance to validate deposit
      if (type === "deposit") {
        const mainBalanceResult = await client.query(
          `SELECT COALESCE(SUM(
             CASE 
               WHEN type = 'deposit' THEN amount::numeric
               WHEN type = 'withdraw' THEN -amount::numeric
               ELSE 0
             END
           ), 0) AS balance
           FROM transactions
           WHERE user_id = $1 
             AND status = 'completed'
             AND vault_id IS NULL`,
          [userId],
        );

        const mainBalance = parseFloat(mainBalanceResult.rows[0]?.balance || "0");
        if (mainBalance < amountNum) {
          throw new Error("Insufficient main balance");
        }
      }

      // Calculate new vault balance
      const newBalance = type === "deposit" 
        ? (currentBalance + amountNum).toString()
        : (currentBalance - amountNum).toString();

      // Update vault balance
      await this.updateBalance(vaultId, newBalance, client);

      // Create vault transaction record
      const vaultTransaction = await this.createVaultTransaction(
        {
          vaultId,
          userId,
          type,
          amount,
          description,
        },
        client,
      );

      // Create corresponding main transaction
      const { TransactionModel } = await import("./transaction.js");
      const transactionModel = new TransactionModel();
      
      // Note: This creates a record of the vault transfer in the main transactions table
      // The actual balance calculation will account for this when vault_id is set
      await client.query(
        `INSERT INTO transactions (
          reference_number, type, amount, phone_number, provider, 
          stellar_address, status, user_id, vault_id, notes
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )`,
        [
          `VAULT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type === "deposit" ? "withdraw" : "deposit", // Opposite for main balance
          amount,
          "vault-transfer", // Placeholder phone
          "internal", // Internal provider
          "vault-system", // Placeholder stellar address
          "completed",
          userId,
          vaultId,
          `Vault ${type}: ${vault.name}${description ? ` - ${description}` : ""}`,
        ],
      );

      await client.query("COMMIT");

      // Return updated vault
      const updatedVault = await this.findById(vaultId);
      return {
        vault: updatedVault!,
        vaultTransaction,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}