import { queryRead, queryWrite } from "../config/database";
import type {
  FeeDistributionRule,
  FeeDistributionShare,
  CreateFeeDistributionRuleRequest,
} from "../services/feeDistributionEngine";
import { validateFeeDistributionShares } from "../services/feeDistributionEngine";

export interface FeeDistributionRuleRow {
  id: string;
  name: string;
  description: string | null;
  shares: FeeDistributionShare[] | string;
  is_active: boolean;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export class FeeDistributionRuleModel {
  async createRule(
    data: CreateFeeDistributionRuleRequest & { createdBy: string },
  ): Promise<FeeDistributionRule> {
    const validation = validateFeeDistributionShares(data.shares);
    if (!validation.isValid) {
      throw new Error(
        `Invalid fee distribution shares: ${validation.errors.join("; ")}`,
      );
    }

    const res = await queryWrite<FeeDistributionRuleRow>(
      `INSERT INTO fee_distribution_rules
        (name, description, shares, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING *`,
      [
        data.name,
        data.description ?? null,
        JSON.stringify(data.shares),
        data.createdBy,
      ],
    );
    return this.mapRow(res.rows[0]);
  }

  async getActiveRuleByName(name: string): Promise<FeeDistributionRule | null> {
    const res = await queryRead<FeeDistributionRuleRow>(
      `SELECT * FROM fee_distribution_rules WHERE name = $1 AND is_active = true`,
      [name],
    );
    return res.rows[0] ? this.mapRow(res.rows[0]) : null;
  }

  async getRuleById(id: string): Promise<FeeDistributionRule | null> {
    const res = await queryRead<FeeDistributionRuleRow>(
      `SELECT * FROM fee_distribution_rules WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? this.mapRow(res.rows[0]) : null;
  }

  async listActiveRules(): Promise<FeeDistributionRule[]> {
    const res = await queryRead<FeeDistributionRuleRow>(
      `SELECT * FROM fee_distribution_rules WHERE is_active = true ORDER BY name ASC`,
    );
    return res.rows.map(this.mapRow);
  }

  async updateShares(
    id: string,
    shares: FeeDistributionShare[],
    updatedBy: string,
  ): Promise<void> {
    const validation = validateFeeDistributionShares(shares);
    if (!validation.isValid) {
      throw new Error(
        `Invalid fee distribution shares: ${validation.errors.join("; ")}`,
      );
    }

    await queryWrite(
      `UPDATE fee_distribution_rules
       SET shares = $2, updated_by = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, JSON.stringify(shares), updatedBy],
    );
  }

  async deactivateRule(id: string, updatedBy: string): Promise<void> {
    await queryWrite(
      `UPDATE fee_distribution_rules
       SET is_active = false, updated_by = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, updatedBy],
    );
  }

  private mapRow(row: FeeDistributionRuleRow): FeeDistributionRule {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      isActive: row.is_active,
      shares:
        typeof row.shares === "string" ? JSON.parse(row.shares) : row.shares,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export const feeDistributionRuleModel = new FeeDistributionRuleModel();
