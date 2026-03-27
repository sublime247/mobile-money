/**
 * Fee calculation utility.
 *
 * Now uses dynamic fee configurations from database with fallback to environment variables.
 * Provides backward compatibility while enabling runtime fee adjustments.
 *
 * Example:
 *   Amount: 10000, Fee: 1.5%, Min: 50, Max: 5000
 *   Calculated: 10000 * 0.015 = 150
 *   Result: { fee: 150, total: 10150, configUsed: 'default' }
 */

import { feeService } from "../services/feeService";

// Fallback constants from environment variables
const FEE_PERCENTAGE = parseFloat(process.env.FEE_PERCENTAGE ?? "1.5");
const FEE_MINIMUM = parseFloat(process.env.FEE_MINIMUM ?? "50");
const FEE_MAXIMUM = parseFloat(process.env.FEE_MAXIMUM ?? "5000");

export interface FeeResult {
  fee: number;
  total: number;
  configUsed?: string;
}

/**
 * Calculate fee using dynamic configuration (preferred method)
 */
export async function calculateFee(amount: number): Promise<FeeResult> {
  try {
    return await feeService.calculateFee(amount);
  } catch (error) {
    console.warn("Failed to use dynamic fee configuration, falling back to env vars:", error);
    return calculateFeeSync(amount);
  }
}

/**
 * Synchronous fee calculation using environment variables (fallback)
 */
export function calculateFeeSync(amount: number): FeeResult {
  let fee = amount * (FEE_PERCENTAGE / 100);

  if (fee < FEE_MINIMUM) fee = FEE_MINIMUM;
  if (fee > FEE_MAXIMUM) fee = FEE_MAXIMUM;

  return {
    fee: parseFloat(fee.toFixed(2)),
    total: parseFloat((amount + fee).toFixed(2)),
    configUsed: 'env_fallback',
  };
}
