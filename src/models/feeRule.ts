import { pool, queryRead, queryWrite } from "../config/database";

/**
 * Provider fee rules (#2294).
 *
 * Mobile money provider fees live in the provider_fee_rules table so operators
 * can change them without a redeploy. A rule charges either a fixed amount or a
 * percentage (in basis points) of the transaction amount, clamped to
 * [minFee, maxFee]. Validation here mirrors the table's CHECK constraints.
 */

export type FeeType = "fixed" | "percent";

export const MAX_BASIS_POINTS = 10_000; // 100%

export interface ProviderFeeRule {
  id: string;
  provider: string;
  currency: string;
  feeType: FeeType;
  /** Fee per transaction in currency units (fixed rules only). */
  fixedAmount: number | null;
  /** Fee as basis points of the amount, 1 bp = 0.01% (percent rules only). */
  basisPoints: number | null;
  minFee: number;
  maxFee: number | null;
  isActive: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderFeeRuleInput {
  provider: string;
  currency: string;
  feeType: FeeType;
  fixedAmount?: number | null;
  basisPoints?: number | null;
  minFee?: number;
  maxFee?: number | null;
  createdBy?: string | null;
}

export interface ProviderFeeRuleRow {
  id: string;
  provider: string;
  currency: string;
  fee_type: FeeType;
  fixed_amount: string | number | null;
  basis_points: number | null;
  min_fee: string | number;
  max_fee: string | number | null;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface FeeRuleValidationResult {
  isValid: boolean;
  errors: string[];
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateFeeRule(
  input: ProviderFeeRuleInput,
): FeeRuleValidationResult {
  const errors: string[] = [];

  if (!input.provider || !input.provider.trim()) {
    errors.push("provider is required");
  }
  if (!/^[A-Z]{3}$/.test(input.currency ?? "")) {
    errors.push("currency must be a 3-letter uppercase ISO 4217 code");
  }

  if (input.feeType === "fixed") {
    if (!isNonNegativeNumber(input.fixedAmount)) {
      errors.push("fixedAmount must be a non-negative number for fixed fees");
    }
    if (input.basisPoints != null) {
      errors.push("basisPoints must not be set for fixed fees");
    }
  } else if (input.feeType === "percent") {
    if (
      !Number.isInteger(input.basisPoints) ||
      (input.basisPoints as number) < 0 ||
      (input.basisPoints as number) > MAX_BASIS_POINTS
    ) {
      errors.push(
        `basisPoints must be an integer between 0 and ${MAX_BASIS_POINTS}`,
      );
    }
    if (input.fixedAmount != null) {
      errors.push("fixedAmount must not be set for percent fees");
    }
  } else {
    errors.push("feeType must be 'fixed' or 'percent'");
  }

  const minFee = input.minFee ?? 0;
  if (!isNonNegativeNumber(minFee)) {
    errors.push("minFee must be a non-negative number");
  }
  if (input.maxFee != null) {
    if (!isNonNegativeNumber(input.maxFee)) {
      errors.push("maxFee must be a non-negative number");
    } else if (isNonNegativeNumber(minFee) && input.maxFee < minFee) {
      errors.push("maxFee must be greater than or equal to minFee");
    }
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Applies a rule to a transaction amount. Pure — no I/O.
 * Result is rounded to 2 decimal places, matching src/utils/fees.ts.
 */
export function calculateProviderFee(
  rule: Pick<
    ProviderFeeRule,
    "feeType" | "fixedAmount" | "basisPoints" | "minFee" | "maxFee"
  >,
  amount: number,
): number {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("amount must be a non-negative number");
  }

  let fee =
    rule.feeType === "fixed"
      ? (rule.fixedAmount ?? 0)
      : (amount * (rule.basisPoints ?? 0)) / MAX_BASIS_POINTS;

  if (fee < rule.minFee) fee = rule.minFee;
  if (rule.maxFee != null && fee > rule.maxFee) fee = rule.maxFee;

  return parseFloat(fee.toFixed(2));
}

function toNumberOrNull(value: string | number | null): number | null {
  return value == null ? null : Number(value);
}

export class FeeRuleRepository {
  async listActive(): Promise<ProviderFeeRule[]> {
    const res = await queryRead<ProviderFeeRuleRow>(
      `SELECT * FROM provider_fee_rules
       WHERE is_active = true
       ORDER BY provider ASC, currency ASC`,
    );
    return res.rows.map(mapFeeRuleRow);
  }

  async listHistory(
    provider: string,
    currency: string,
  ): Promise<ProviderFeeRule[]> {
    const res = await queryRead<ProviderFeeRuleRow>(
      `SELECT * FROM provider_fee_rules
       WHERE provider = $1 AND currency = $2
       ORDER BY created_at DESC`,
      [provider.toLowerCase(), currency],
    );
    return res.rows.map(mapFeeRuleRow);
  }

  /**
   * Validates and inserts a rule as the active rule for its provider/currency,
   * deactivating the previous active rule in the same transaction.
   *
   * The UPDATE and INSERT must be separate statements: in a single statement
   * (e.g. a data-modifying CTE) the partial unique index still sees the old
   * active row and the INSERT fails. The advisory lock serialises concurrent
   * replacements of the same provider/currency instead of letting the loser
   * fail on that index.
   */
  async replaceActive(input: ProviderFeeRuleInput): Promise<ProviderFeeRule> {
    const validation = validateFeeRule(input);
    if (!validation.isValid) {
      throw new Error(`Invalid fee rule: ${validation.errors.join("; ")}`);
    }

    const provider = input.provider.trim().toLowerCase();
    const actor = input.createdBy ?? null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `provider_fee_rules:${provider}:${input.currency}`,
      ]);
      await client.query(
        `UPDATE provider_fee_rules
         SET is_active = false, updated_by = $3, updated_at = NOW()
         WHERE provider = $1 AND currency = $2 AND is_active = true`,
        [provider, input.currency, actor],
      );
      const res = await client.query<ProviderFeeRuleRow>(
        `INSERT INTO provider_fee_rules
           (provider, currency, fee_type, fixed_amount, basis_points,
            min_fee, max_fee, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING *`,
        [
          provider,
          input.currency,
          input.feeType,
          input.feeType === "fixed" ? input.fixedAmount : null,
          input.feeType === "percent" ? input.basisPoints : null,
          input.minFee ?? 0,
          input.maxFee ?? null,
          actor,
        ],
      );
      await client.query("COMMIT");
      return mapFeeRuleRow(res.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivate(id: string, updatedBy: string | null): Promise<boolean> {
    const res = await queryWrite(
      `UPDATE provider_fee_rules
       SET is_active = false, updated_by = $2, updated_at = NOW()
       WHERE id = $1 AND is_active = true`,
      [id, updatedBy],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

export function mapFeeRuleRow(row: ProviderFeeRuleRow): ProviderFeeRule {
  return {
    id: row.id,
    provider: row.provider,
    currency: row.currency,
    feeType: row.fee_type,
    fixedAmount: toNumberOrNull(row.fixed_amount),
    basisPoints: row.basis_points,
    minFee: Number(row.min_fee),
    maxFee: toNumberOrNull(row.max_fee),
    isActive: row.is_active,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export const feeRuleRepository = new FeeRuleRepository();
